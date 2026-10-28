#!/bin/sh
set -eu

: "${MAIL_HOSTNAME:?MAIL_HOSTNAME is required}"
: "${MAIL_DOMAINS:?MAIL_DOMAINS is required}"
: "${ALLOWED_SENDER_DOMAINS:?ALLOWED_SENDER_DOMAINS is required}"

secret_is_configured() {
  secret_name="$1"
  eval "secret_value=\${$secret_name:-}"
  eval "secret_file=\${${secret_name}_FILE:-}"
  [ -n "$secret_value" ] || { [ -n "$secret_file" ] && [ -r "$secret_file" ] && [ -s "$secret_file" ]; }
}

if ! secret_is_configured RELAY_SHARED_SECRET \
  && ! secret_is_configured LONGOS_RELAY_SHARED_SECRET \
  && ! secret_is_configured CLOUD_MAIL_RELAY_SHARED_SECRET; then
  echo "At least one relay client secret is required" >&2
  exit 1
fi

DKIM_SELECTOR="${DKIM_SELECTOR:-mail2026}"
INET_PROTOCOLS="${INET_PROTOCOLS:-ipv4}"
DNS_RECORDS_PATH="${DNS_RECORDS_PATH:-/var/lib/cloud-mail-relay-dns}"

case "$DNS_RECORDS_PATH" in
  /*) ;;
  *) echo "DNS_RECORDS_PATH must be an absolute path" >&2; exit 1 ;;
esac

normalize_domain() {
  node --input-type=module -e '
    import { domainToASCII } from "node:url";
    const domain = domainToASCII(String(process.argv[1] || "").trim().toLowerCase().replace(/\.$/, ""));
    const labels = domain.split(".");
    if (!domain || domain.length > 253 || labels.length < 2
      || labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) process.exit(1);
    process.stdout.write(domain);
  ' "$1"
}

if ! MAIL_HOSTNAME="$(normalize_domain "$MAIL_HOSTNAME")"; then
  echo "MAIL_HOSTNAME must be a valid DNS hostname" >&2
  exit 1
fi
if ! printf '%s' "$DKIM_SELECTOR" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$'; then
  echo "DKIM_SELECTOR contains invalid characters" >&2
  exit 1
fi
case "$INET_PROTOCOLS" in
  ipv4|ipv6|all) ;;
  *) echo "INET_PROTOCOLS must be ipv4, ipv6, or all" >&2; exit 1 ;;
esac

normalize_domain_list() {
  list="$1"
  normalized=""
  old_list_ifs="$IFS"
  IFS=','
  for raw_domain in $list; do
    if ! domain="$(normalize_domain "$raw_domain")"; then
      echo "Invalid mail domain: $raw_domain" >&2
      IFS="$old_list_ifs"
      return 1
    fi
    case ",$normalized," in
      *,$domain,*) ;;
      *) normalized="${normalized:+$normalized,}$domain" ;;
    esac
  done
  IFS="$old_list_ifs"
  [ -n "$normalized" ] || return 1
  printf '%s' "$normalized"
}

MAIL_DOMAINS="$(normalize_domain_list "$MAIL_DOMAINS")" || exit 1
ALLOWED_SENDER_DOMAINS="$(normalize_domain_list "$ALLOWED_SENDER_DOMAINS")" || exit 1
export MAIL_HOSTNAME MAIL_DOMAINS ALLOWED_SENDER_DOMAINS DKIM_SELECTOR INET_PROTOCOLS

old_ifs="$IFS"
IFS=','
for allowed_domain in $ALLOWED_SENDER_DOMAINS; do
  case ",$MAIL_DOMAINS," in
    *,$allowed_domain,*) ;;
    *)
      echo "ALLOWED_SENDER_DOMAINS contains unsigned domain: $allowed_domain" >&2
      IFS="$old_ifs"
      exit 1
      ;;
  esac
done
IFS="$old_ifs"

printf '%s\n' "$MAIL_HOSTNAME" > /etc/mailname
mkdir -p /run/opendkim /etc/opendkim /var/lib/dkim "$DNS_RECORDS_PATH"
chown opendkim:opendkim /run/opendkim /var/lib/dkim
chmod 0755 "$DNS_RECORDS_PATH"

: > /etc/opendkim/KeyTable
: > /etc/opendkim/SigningTable
printf '127.0.0.1\nlocalhost\n' > /etc/opendkim/TrustedHosts

old_ifs="$IFS"
IFS=','
for raw_domain in $MAIL_DOMAINS; do
  domain="$(printf '%s' "$raw_domain" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')"
  [ -n "$domain" ] || continue
  key_dir="/var/lib/dkim/$domain"
  mkdir -p "$key_dir"
  if [ ! -s "$key_dir/$DKIM_SELECTOR.private" ]; then
    opendkim-genkey -b 2048 -d "$domain" -D "$key_dir" -s "$DKIM_SELECTOR"
  fi
  chown -R opendkim:opendkim "$key_dir"
  chmod 0700 "$key_dir"
  chmod 0600 "$key_dir/$DKIM_SELECTOR.private"
  printf '%s._domainkey.%s %s:%s:%s/%s.private\n' \
    "$DKIM_SELECTOR" "$domain" "$domain" "$DKIM_SELECTOR" "$key_dir" "$DKIM_SELECTOR" \
    >> /etc/opendkim/KeyTable
  printf '*@%s %s._domainkey.%s\n' "$domain" "$DKIM_SELECTOR" "$domain" \
    >> /etc/opendkim/SigningTable
  printf '%s\n*.%s\n' "$domain" "$domain" >> /etc/opendkim/TrustedHosts

  # The API publishes only this derived public value to LONGOS. The private
  # signing key stays in /var/lib/dkim and is never included in the identity
  # response or mounted into another container.
  public_dir="$DNS_RECORDS_PATH/$domain"
  public_record="$public_dir/$DKIM_SELECTOR.txt"
  public_temp="$public_record.tmp.$$"
  mkdir -p "$public_dir"
  dkim_value="$(grep -o '"[^"]*"' "$key_dir/$DKIM_SELECTOR.txt" | tr -d '"\n')"
  if ! printf '%s' "$dkim_value" | grep -Eqi '^v=DKIM1;.*(^|[;[:space:]])p=[A-Za-z0-9+/=]+'; then
    echo "Unable to extract the public DKIM value for $domain" >&2
    rm -f "$public_temp"
    exit 1
  fi
  umask 022
  printf '%s\n' "$dkim_value" > "$public_temp"
  chmod 0644 "$public_temp"
  mv -f "$public_temp" "$public_record"
done
IFS="$old_ifs"

cat > /etc/opendkim.conf <<EOF
Syslog                  yes
UMask                   007
Mode                    sv
Canonicalization        relaxed/simple
OversignHeaders         From
UserID                  opendkim
PidFile                 /run/opendkim/opendkim.pid
Socket                  inet:8891@127.0.0.1
KeyTable                refile:/etc/opendkim/KeyTable
SigningTable            refile:/etc/opendkim/SigningTable
ExternalIgnoreList      refile:/etc/opendkim/TrustedHosts
InternalHosts           refile:/etc/opendkim/TrustedHosts
EOF

postconf -e "myhostname = $MAIL_HOSTNAME"
postconf -e "myorigin = \$mydomain"
postconf -e "mydestination = localhost"
postconf -e "inet_interfaces = loopback-only"
postconf -e "inet_protocols = $INET_PROTOCOLS"
postconf -e "mynetworks = 127.0.0.0/8 [::1]/128"
postconf -e "relayhost ="
postconf -e "smtp_helo_name = \$myhostname"
postconf -e "smtp_tls_security_level = may"
postconf -e "smtp_tls_CAfile = /etc/ssl/certs/ca-certificates.crt"
postconf -e "smtp_tls_loglevel = 1"
postconf -e "disable_dns_lookups = no"
postconf -e "maillog_file = /dev/stdout"
postconf -e "milter_default_action = tempfail"
postconf -e "milter_protocol = 6"
postconf -e "non_smtpd_milters = inet:127.0.0.1:8891"

opendkim -x /etc/opendkim.conf
postfix check
postfix start

echo "Cloud Mail relay started. Publish each DKIM TXT record shown below:"
find /var/lib/dkim -maxdepth 3 -type f -name '*.txt' -print -exec cat {} \;

node /app/src/server.mjs &
node_pid=$!

shutdown() {
  kill "$node_pid" 2>/dev/null || true
  postfix stop 2>/dev/null || true
  pkill opendkim 2>/dev/null || true
  wait "$node_pid" 2>/dev/null || true
}

trap shutdown INT TERM EXIT
wait "$node_pid"
