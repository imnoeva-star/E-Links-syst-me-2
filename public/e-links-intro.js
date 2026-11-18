// Reuse in another project: copy this file and e-links-intro.css, link both,
// add <e-links-intro></e-links-intro>, then call playWelcome('Nom') or dismiss().
(() => {
  if (customElements.get('e-links-intro')) return;

  class ELinksIntro extends HTMLElement {
    connectedCallback() {
      if (this.shadowRoot) return;
      this.attachShadow({ mode: 'open' });
      this.shadowRoot.innerHTML = `
        <link rel="stylesheet" href="/e-links-intro.css">
        <div class="e-links-intro-scene">
          <div class="e-links-intro-brand-stage">
            <div class="e-links-intro-brand-scene" aria-hidden="true">
              <span class="e-links-intro-bubble e-links-intro-brand-bubble e-links-intro-blue"></span>
              <span class="e-links-intro-bubble e-links-intro-brand-bubble e-links-intro-violet"></span>
              <span class="e-links-intro-bubble e-links-intro-brand-bubble e-links-intro-sky"></span>
              <span class="e-links-intro-wordmark">E-Links</span>
            </div>
            <p class="e-links-intro-caption">Chargement E-Links…</p>
          </div>
          <div class="e-links-intro-greeting-stage" hidden>
            <p class="e-links-intro-greeting" aria-hidden="true"></p>
          </div>
          <span class="e-links-intro-sr-only e-links-intro-announcement" role="status" aria-live="polite">
            Chargement E-Links
          </span>
        </div>
      `;
      this.brandStage = this.shadowRoot.querySelector('.e-links-intro-brand-stage');
      this.greetingStage = this.shadowRoot.querySelector('.e-links-intro-greeting-stage');
      this.greetingElement = this.shadowRoot.querySelector('.e-links-intro-greeting');
      this.announcement = this.shadowRoot.querySelector('.e-links-intro-announcement');
      this.startedAt = performance.now();
      this.inert = false;
      this.dataset.dismissed = 'false';
    }

    showBrand() {
      window.clearTimeout(this.dismissTimer);
      this.dataset.dismissed = 'false';
      this.inert = false;
      this.removeAttribute('aria-hidden');
      this.brandStage.hidden = false;
      this.greetingStage.hidden = true;
      this.greetingElement.textContent = '';
      this.startedAt = performance.now();
      this.announcement.textContent = 'Chargement E-Links';
    }

    async playWelcome(name) {
      this.showBrand();
      await this.pause(500);
      this.brandStage.hidden = true;
      this.greetingStage.hidden = false;
      const displayName = String(name || '').trim();
      const greeting = displayName ? `Bonjour, ${displayName} !` : 'Bonjour !';
      this.greetingElement.textContent = '';
      this.greetingElement.classList.add('is-typing');
      for (const letter of greeting) {
        this.greetingElement.textContent += letter;
        if (!this.reducedMotion) await this.pause(42);
      }
      this.greetingElement.classList.remove('is-typing');
      this.announcement.textContent = greeting;
      await this.pause(550);
      this.dataset.dismissed = 'true';
      this.inert = true;
      this.setAttribute('aria-hidden', 'true');
      this.announcement.textContent = '';
      await this.pause(420);
      this.dispatchEvent(new CustomEvent('complete', { bubbles: true }));
    }

    dismiss() {
      const minimumBrandTime = 500;
      const elapsed = performance.now() - this.startedAt;
      const delay = this.reducedMotion ? 0 : Math.max(0, minimumBrandTime - elapsed);
      return new Promise((resolve) => {
        this.dismissTimer = window.setTimeout(() => {
          this.dataset.dismissed = 'true';
          this.inert = true;
          this.setAttribute('aria-hidden', 'true');
          this.announcement.textContent = '';
          resolve();
        }, delay);
      });
    }

    get reducedMotion() {
      return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    }

    pause(milliseconds) {
      return new Promise((resolve) => {
        window.setTimeout(resolve, this.reducedMotion ? 0 : milliseconds);
      });
    }
  }

  customElements.define('e-links-intro', ELinksIntro);
})();
