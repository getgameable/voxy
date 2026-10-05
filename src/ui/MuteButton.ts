const MIC_ICON = `
<svg class="voxy-mute-btn__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <rect x="9" y="3" width="6" height="11" rx="3"/>
  <path d="M5 11a7 7 0 0 0 14 0"/>
  <line x1="12" y1="18" x2="12" y2="22"/>
</svg>`.trim()

const MIC_OFF_ICON = `
<svg class="voxy-mute-btn__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M15 9.5V6a3 3 0 0 0-6 0v2"/>
  <path d="M9 11v.5a3 3 0 0 0 5 2.24"/>
  <path d="M5 11a7 7 0 0 0 11.3 5.5"/>
  <path d="M19 11a7 7 0 0 1-.3 2"/>
  <line x1="12" y1="18" x2="12" y2="22"/>
  <line x1="3" y1="3" x2="21" y2="21"/>
</svg>`.trim()

export class MuteButton {
  private readonly root: HTMLElement
  private readonly onClick: () => void
  private readonly btn: HTMLButtonElement

  constructor(root: HTMLElement, onClick: () => void) {
    this.root = root
    this.onClick = onClick

    this.btn = document.createElement('button')
    this.btn.className = 'voxy-mute-btn'
    this.btn.type = 'button'
    this.btn.innerHTML = MIC_ICON
    this.btn.setAttribute('aria-label', 'Mute microphone')
    this.btn.addEventListener('click', onClick)
    root.appendChild(this.btn)
  }

  update(muted: boolean, disabled = false): void {
    this.btn.innerHTML = muted ? MIC_OFF_ICON : MIC_ICON
    this.btn.setAttribute('aria-label', muted ? 'Unmute microphone' : 'Mute microphone')
    this.btn.classList.toggle('voxy-mute-btn--muted', muted)
    this.btn.disabled = disabled
  }

  destroy(): void {
    this.btn.removeEventListener('click', this.onClick)
    this.root.removeChild(this.btn)
  }
}
