/**
 * ALL Zoom Web DOM selectors live here and nowhere else.
 *
 * Zoom's Web client markup changes without notice. When the DOM changes, this
 * is the ONLY file that should need editing. Each selector is a *list of
 * candidates* tried in order, so small markup changes degrade gracefully.
 *
 * These are best-effort starting points and MUST be verified against a live
 * meeting (see docs/testing.md → "DOM change tests").
 */

export interface SelectorGroup {
  description: string;
  /** Tried in order; first match wins. */
  candidates: string[];
}

export const selectors = {
  /** Signed-in affordance (avatar / account menu) seen on app.zoom.us. */
  authenticatedMarker: {
    description: "Element that only appears when signed in",
    candidates: [
      '[data-testid="user-avatar"]',
      'button[aria-label*="account" i]',
      'img[alt*="avatar" i]',
      '#headerAvatar',
    ],
  },
  /** Sign-in / sign-up affordance (only present when NOT signed in). EN + PT. */
  signInMarker: {
    description: "Sign-in / sign-up button/link (English + Portuguese)",
    candidates: [
      'a[href*="signin" i]',
      'button:has-text("Sign In")',
      'a:has-text("Sign In")',
      'button:has-text("Sign Up")',
      'button:has-text("Iniciar sessão")',
      'button:has-text("Inscreva-se")',
      'a:has-text("Iniciar sessão")',
      'text=/iniciar sess/i',
      'text=/sign in/i',
    ],
  },
  /** "Join from your browser" link on the launch interstitial. EN + PT. */
  joinFromBrowser: {
    description: "Join-from-browser link on the app-launch interstitial (EN + PT)",
    candidates: [
      'a:has-text("Join from your browser")',
      'a:has-text("Join from Your Browser")',
      'text=/join from (your )?browser/i',
      'a:has-text("Ingressar pelo navegador")',
      'a:has-text("Entrar pelo navegador")',
      'text=/ingressar.*navegador/i',
      'text=/entrar.*navegador/i',
      'a[href*="/wc/join"]',
    ],
  },
  /** Display-name field on the browser-join page. */
  nameInput: {
    description: "Display name input on browser join",
    candidates: [
      '#input-for-name',
      'input[aria-label*="name" i]',
      'input[placeholder*="name" i]',
    ],
  },
  /** Passcode field (when the meeting requires it). */
  passcodeInput: {
    description: "Meeting passcode input",
    candidates: [
      '#input-for-pwd',
      'input[aria-label*="passcode" i]',
      'input[placeholder*="passcode" i]',
      'input[type="password"]',
    ],
  },
  joinButton: {
    description: "Join / submit button on browser-join page (EN + PT)",
    candidates: [
      '#joinBtn',
      'button:has-text("Ingressar")',
      'button:has-text("Entrar")',
      'button:has-text("Join")',
      'button[type="submit"]',
    ],
  },
  /** Container that marks we are inside a meeting (meeting controls bar). EN + PT. */
  inMeetingMarker: {
    description: "In-meeting controls toolbar (EN + PT)",
    candidates: [
      '[aria-label="meeting controls" i]',
      '#foot-bar',
      '.footer__inner',
      'button[aria-label*="Leave" i]',
      'button[aria-label*="Sair" i]',
      'button[aria-label*="Encerrar" i]',
    ],
  },
  participantsToggle: {
    description: "Open the Participants panel (verified: aria has a typo 'particpants')",
    candidates: [
      'button[aria-label*="manage participants list" i]',
      'button[aria-label*="Participants" i]',
      'button[aria-label*="Manage Participants" i]',
      'button[aria-label*="Participantes" i]',
    ],
  },
  participantsPanel: {
    description: "The participants list container (React Virtualized)",
    candidates: [
      '[aria-label="Participants list"]',
      '.participants-list-container',
      '.ReactVirtualized__List',
      '[aria-label*="participants list" i]',
    ],
  },
  participantRow: {
    description: "A single participant row (verified class .participants-li)",
    candidates: ['.participants-li', '.participants-item', 'li[role="listitem"]'],
  },
  /** Within a row: the hand-raised indicator. */
  handRaisedIndicator: {
    description: "Raised-hand icon/aria within a participant row",
    candidates: [
      '[aria-label*="raised hand" i]',
      '[aria-label*="hand raised" i]',
      '[class*="raise-hand" i]',
      'svg[aria-label*="hand" i]',
    ],
  },
  /** Waiting-room "Admit" buttons (per participant, in the panel or a toast). */
  admitButton: {
    description: "Admit a single waiting participant",
    candidates: [
      'button:has-text("Admit")',
      'button[aria-label*="Admit" i]',
      'button:has-text("Admitir")',
    ],
  },
  admitAllButton: {
    description: "Admit all waiting participants",
    candidates: [
      'button:has-text("Admit all")',
      'button:has-text("Admit All")',
      'button:has-text("Admitir todos")',
    ],
  },
  /** Host-controls menu (the shield). In this client it is "Host Tools". */
  securityButton: {
    description: "Host Tools / Security menu button",
    candidates: [
      'button[aria-label*="Host Tools" i]',
      'button:has-text("Host Tools")',
      'button[aria-label*="Security" i]',
      'button:has-text("Security")',
      'button[aria-label*="Seguran" i]',
    ],
  },
  /** "Allow participants to unmute themselves" item inside the Security menu. */
  allowUnmuteItem: {
    description: "Allow-participants-to-unmute-themselves menu item",
    candidates: [
      'text=/unmute themselves/i',
      '[role="menuitemcheckbox"]:has-text("Unmute")',
      'text=/se desmutar/i',
    ],
  },
  /** Per-row unmute / ask-to-unmute action (revealed on hover). EN + PT. */
  rowUnmuteButton: {
    description: "Unmute / ask-to-unmute a participant in their row (EN + PT)",
    candidates: [
      'button[aria-label*="unmute" i]',
      'button:has-text("Unmute")',
      'button:has-text("Ask to Unmute")',
      'button[aria-label*="ativar o som" i]',
      'button[aria-label*="pedir para ativar" i]',
      'button:has-text("Ativar o som")',
      'button:has-text("Pedir para ativar")',
    ],
  },
  /** Per-row "More" menu button (EN + PT). */
  rowMoreButton: {
    description: "Per-row More/options menu button (EN + PT)",
    candidates: ['button[aria-label*="more" i]', 'button[aria-label*="Mais" i]'],
  },
  leaveButton: {
    description: "Leave/End meeting button (EN + PT)",
    candidates: [
      'button[aria-label*="Leave" i]',
      'button:has-text("Leave")',
      'button:has-text("End")',
      'button[aria-label*="Sair" i]',
      'button:has-text("Sair")',
      'button:has-text("Encerrar")',
    ],
  },
  shareButton: {
    description: "Share screen button in the meeting toolbar (EN + PT)",
    candidates: [
      'button[aria-label="Share"]',
      'button[aria-label*="Share Screen" i]',
      'button[aria-label*="Compartilhar tela" i]',
      'button[aria-label*="Compartilhar" i]',
    ],
  },
  stopShareButton: {
    description: "Stop screen share button (appears while sharing). In Zoom Web "
      + "this control carries only visible text, no aria-label, so text matches "
      + "come first (an aria candidate first would burn the whole timeout).",
    candidates: [
      'button:has-text("Stop Share")',
      'button:has-text("Parar compartilhamento")',
      'button:has-text("Parar de compartilhar")',
      'button[aria-label*="Stop Share" i]',
      'button[aria-label*="Parar compartilhamento" i]',
    ],
  },
  moreButton: {
    description: "'More' overflow button in the meeting toolbar. A narrow window "
      + "(the participants panel docked shrinks the meeting area) collapses Share "
      + "/ Stop Share out of the toolbar into this menu.",
    candidates: [
      'button[aria-label*="More meeting control" i]',
      'button[aria-label*="Mais controles" i]',
      'button[aria-label="More"]',
    ],
  },
  /** Opens the Polls/Quizzes panel. VERIFIED: button aria-label="Polls"
   *  (class more-button__item-box inside the More menu on a narrow window, or
   *  footer-button__button directly in a wide toolbar). EN + PT. */
  pollsButton: {
    description: "Open the Polls/Quizzes panel (toolbar or More menu). EN + PT.",
    candidates: [
      'button[aria-label="Polls"]',
      'button[aria-label*="Polls" i]',
      'button[aria-label="Enquetes"]',
      'button[aria-label*="Enquete" i]',
      'button[aria-label*="Pesquisas" i]',
      'button[aria-label*="Poll" i]',
    ],
  },
  /** Marks that the Polls panel is open (VERIFIED: .poll-list-item rows, the
   *  "Surveys & Polls" header). */
  pollPanel: {
    description: "Polls panel open marker (list container / rows / header)",
    candidates: [
      '.poll-list-item',
      '.poll-list-container',
      'text=/Surveys & Polls/i',
      'text=/Polls\\/Quizzes/i',
    ],
  },
  /** The "Launch" button on a poll row (VERIFIED: revealed on hover; class
   *  poll-list-item__action-button; aria "Launch <poll name>"). EN + PT. */
  pollLaunchButton: {
    description: "Launch a poll from its row in the Polls panel (EN + PT)",
    candidates: [
      'button.poll-list-item__action-button',
      'button[aria-label^="Launch" i]',
      'button[aria-label^="Lançar" i]',
      'button:has-text("Launch")',
      'button:has-text("Lançar")',
    ],
  },
} as const satisfies Record<string, SelectorGroup>;

export type SelectorKey = keyof typeof selectors;
