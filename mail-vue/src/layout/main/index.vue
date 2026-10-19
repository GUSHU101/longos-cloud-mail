<template>
  <div :class="accountShow && hasPerm('account:query') ? 'main-box-show' : 'main-box-hide'">
    <div :class="accountShow && hasPerm('account:query') ? 'block-show' : 'block-hide'" @click="uiStore.accountShow = false"></div>
    <account  :class="accountShow && hasPerm('account:query') ? 'show' : 'hide'" />
    <router-view class="main-view" v-slot="{ Component,route }">
      <keep-alive :include="['email','all-email','send','sys-setting','star','user','role','analysis','reg-key','draft']">
        <component :is="Component" :key="route.name"/>
      </keep-alive>
    </router-view>
  </div>
</template>
<script setup>
import account from '@/layout/account/index.vue'
import {useUiStore} from "@/store/ui.js";
import {useSettingStore} from "@/store/setting.js";
import {computed, onBeforeUnmount, onMounted, watch} from "vue";
import { useRoute } from 'vue-router'
import { hasPerm } from "@/perm/perm.js"
import {sanitizeNoticeHtml} from "@/utils/html-sanitizer.js";

const settingStore = useSettingStore()
const uiStore = useUiStore();
const route = useRoute()
let  innerWidth =  window.innerWidth

let elNotification = null
let noticeStyleElement = null

const accountShow = computed(() => {
  return uiStore.accountShow && settingStore.settings.manyEmail === 0
})

watch(() => uiStore.changeNotice, () => {

  const settings = settingStore.settings

  let data = {
    notice: settings.notice,
    noticeWidth: settings.noticeWidth,
    noticeTitle: settings.noticeTitle,
    noticeContent: settings.noticeContent,
    noticeType: settings.noticeType,
    noticeDuration: settings.noticeDuration,
    noticePosition: settings.noticePosition,
    noticeOffset: settings.noticeOffset
  }

  showNotice(data)
})

watch(() => uiStore.changePreview, () => {
  showNotice(uiStore.previewData)
})

function showNotice(data) {

  if (data.notice === 1) {
    return;
  }

  if (elNotification) {
    elNotification.close()
  }

  const numericWidth = Number(data.noticeWidth)
  const noticeWidth = Number.isFinite(numericWidth) ? Math.min(1200, Math.max(240, numericWidth)) : 400
  const numericDuration = Number(data.noticeDuration)
  const noticeDuration = Number.isFinite(numericDuration) ? Math.min(3600000, Math.max(0, numericDuration)) : 0
  const numericOffset = Number(data.noticeOffset)
  const noticeOffset = Number.isFinite(numericOffset) ? Math.min(1000, Math.max(0, numericOffset)) : 0
  const allowedTypes = new Set(['', 'none', 'success', 'warning', 'info', 'error'])
  const allowedPositions = new Set(['top-right', 'top-left', 'bottom-right', 'bottom-left'])

  if (!noticeStyleElement) {
    noticeStyleElement = document.createElement('style')
    document.head.appendChild(noticeStyleElement)
  }
  noticeStyleElement.textContent = `
  .custom-notice.el-notification {
    --el-notification-width: min(${noticeWidth}px,calc(100% - 30px)) !important;
  }
  `;

  elNotification = ElNotification({
    title: String(data.noticeTitle || '').slice(0, 200),
    message: sanitizeNoticeHtml(data.noticeContent),
    type: allowedTypes.has(data.noticeType) && data.noticeType !== 'none' ? data.noticeType : '',
    duration: noticeDuration,
    position: allowedPositions.has(data.noticePosition) ? data.noticePosition : 'top-right',
    offset: noticeOffset,
    dangerouslyUseHTMLString: true,
    customClass: 'custom-notice'
  })
}

onMounted(() => {
  window.addEventListener('resize', handleResize)
  handleResize()
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', handleResize)
  elNotification?.close()
  noticeStyleElement?.remove()
  noticeStyleElement = null
})

const handleResize = () => {
  if (['content','email','send'].includes(route.meta.name)) {
    if (innerWidth !==  window.innerWidth) {
      innerWidth = window.innerWidth;
      uiStore.accountShow = window.innerWidth >= 767;
    }
  }
}

</script>
<style lang="scss" scoped>

.block-show {
  position: fixed;
  @media (max-width: 767px) {
    position: absolute;
    right: 0;
    border: 0;
    height: 100%;
    width: 100%;
    background: #000000;
    opacity: 0.6;
    z-index: 10;
    transition: all 300ms;
  }
}

.block-hide {
  position: fixed;
  pointer-events: none;
  transition: all 300ms;
}

.show {
  transition: all 100ms;
  @media (max-width: 767px) {
    position: fixed;
    z-index: 100;
    width: 260px;
  }
}

.hide {
  transition: all 100ms;
  position: fixed;
  transform: translateX(-100%);
  opacity: 0;
  @media (max-width: 1024px) {
    width: 260px;
    z-index: 100;
  }
}


.main-box-show {
  display: grid;
  grid-template-columns: 260px  1fr;
  height: calc(100% - 60px);
  @media (max-width: 767px) {
    grid-template-columns: 1fr;
  }
}

.main-box-hide {
  display: grid;
  grid-template-columns: 1fr;
  height: calc(100% - 60px);
}


.main-view {
  background: var(--el-bg-color);
}


.navigation {
  height: 30px;
  border-bottom: solid 1px var(--el-menu-border-color);
  display: inline-flex;
  justify-items: center;
  align-items: center;
  width: 100%;
  .tag {
    background: var(--el-bg-color);
    margin-left: 5px;
  }
}
</style>
