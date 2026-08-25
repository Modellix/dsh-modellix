export const MODELLIX_CLIENT_CSS = String.raw`
.mdlx-settings,.mdlx-design,.mdlx-modal-content{font-family:var(--dsw-font-family,inherit);color:var(--dsw-alias-label-primary)}
.mdlx-settings{width:min(100%,760px);display:grid;gap:12px;padding:4px}
.mdlx-heading{display:grid;gap:4px;margin:0 0 8px}.mdlx-heading h2,.mdlx-heading h3,.mdlx-heading p{margin:0}
.mdlx-heading h2{font-size:20px;line-height:28px;font-weight:500}.mdlx-heading h3{font-size:15px;line-height:22px;font-weight:600}
.mdlx-muted,.mdlx-help{color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1.5;overflow-wrap:anywhere}
.mdlx-card{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1);padding:16px;display:grid;gap:16px}
.mdlx-card-head,.mdlx-status-row,.mdlx-actions,.mdlx-result-head{display:flex;align-items:center;gap:12px;justify-content:space-between;flex-wrap:wrap}
.mdlx-status-copy{display:flex;align-items:center;gap:8px;min-width:0}.mdlx-status-copy span{overflow-wrap:anywhere}
.mdlx-actions{justify-content:flex-end}.mdlx-actions-start{justify-content:flex-start}.mdlx-grow{flex:1 1 auto}
.mdlx-service-list{display:grid;gap:8px}.mdlx-switch-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:16px;align-items:center;padding:12px;border-radius:12px;border:1px solid var(--dsw-alias-border-l2)}
.mdlx-switch-copy{display:grid;gap:2px}.mdlx-switch-copy strong{font-size:14px;font-weight:500}.mdlx-switch-copy span{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.mdlx-switch{width:24px;height:24px;accent-color:var(--dsw-alias-brand-primary);cursor:pointer}.mdlx-switch:disabled{cursor:not-allowed}
.mdlx-field{display:grid;gap:8px;min-width:0}.mdlx-label{font-size:14px;font-weight:500}.mdlx-required{color:var(--dsw-alias-state-error-primary);margin-inline-start:4px}
.mdlx-input-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;align-items:center}.mdlx-input{width:100%;min-width:0}
.mdlx-model-tools{display:grid;grid-template-columns:minmax(120px,1fr) minmax(112px,.45fr) auto;gap:8px;align-items:center}
.mdlx-textarea,.mdlx-select,.mdlx-native-input{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;line-height:22px;padding:10px 12px}
.mdlx-textarea{min-height:108px;resize:vertical}.mdlx-textarea-small{min-height:80px}.mdlx-select,.mdlx-native-input{min-height:40px}
.mdlx-textarea:hover,.mdlx-select:hover,.mdlx-native-input:hover{border-color:var(--dsw-alias-border-l3)}
.mdlx-error{border-radius:12px;background:var(--dsw-alias-state-error-secondary);color:var(--dsw-alias-state-error-primary);padding:10px 12px;font-size:13px;line-height:20px}
.mdlx-info{border-radius:12px;background:var(--dsw-alias-state-business-tertiary);color:var(--dsw-alias-label-primary);padding:10px 12px;font-size:13px;line-height:20px}
.mdlx-live{min-height:20px;font-size:13px;color:var(--dsw-alias-label-secondary)}
.mdlx-safe-link{display:inline-flex;align-items:center;gap:6px;color:var(--dsw-alias-brand-text);font-size:13px;text-decoration:none;min-height:24px}.mdlx-safe-link:hover{text-decoration:underline}
.mdlx-link-button{appearance:none;border:0;padding:0;background:transparent;font:inherit;cursor:pointer}
.mdlx-modal{width:min(600px,calc(100vw - 48px));max-height:calc(100dvh - 48px);border-radius:24px!important;box-shadow:var(--dsw-shadow-lv3)!important;overflow:auto;overscroll-behavior:contain}
.mdlx-modal-content{box-sizing:border-box;padding:28px;display:grid;gap:20px;outline:none}.mdlx-modal-title{font-size:20px;line-height:28px;font-weight:500;margin:0}.mdlx-modal-description{font-size:14px;line-height:22px;color:var(--dsw-alias-label-secondary);margin:0}
.mdlx-design{height:100%;min-height:0;box-sizing:border-box;padding:16px;overflow:auto;background:var(--dsw-alias-bg-base)}
.mdlx-design-shell{min-height:100%;display:grid;grid-template-columns:minmax(300px,42fr) minmax(360px,58fr);gap:16px}
.mdlx-design-pane{min-width:0;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1);padding:16px;display:flex;flex-direction:column;gap:16px}
.mdlx-design-scroll{display:grid;gap:16px;min-height:0}.mdlx-parameter-list{display:grid;gap:12px}.mdlx-parameter{display:grid;gap:6px;border-top:1px solid var(--dsw-alias-border-l2);padding-top:12px}
.mdlx-advanced{display:grid;gap:12px;border-top:1px solid var(--dsw-alias-border-l2);padding-top:12px}.mdlx-advanced>summary{cursor:pointer;font-size:14px;font-weight:500;min-height:24px}.mdlx-advanced[open]>summary{margin-bottom:12px}
.mdlx-proposal{display:grid;gap:12px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:12px;background:var(--dsw-alias-bg-layer-2)}
.mdlx-change-list{display:grid;gap:8px;margin:0;padding:0;list-style:none}.mdlx-change{display:grid;grid-template-columns:minmax(100px,.4fr) minmax(0,1fr);gap:8px;font-size:13px}.mdlx-code{font-family:var(--ds-font-family-code,monospace);font-size:12px;overflow-wrap:anywhere}
.mdlx-result-section{display:grid;gap:10px}.mdlx-result-section h3{margin:0;font-size:14px;font-weight:600}.mdlx-result-list{display:grid;gap:12px;margin:0;padding:0;list-style:none}
.mdlx-result-card{display:grid;gap:12px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:12px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}
.mdlx-resource-list{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px}.mdlx-resource{display:grid;gap:8px;min-width:0}.mdlx-media{display:block;width:100%;max-height:360px;object-fit:contain;border-radius:12px;background:var(--dsw-alias-bg-layer-3)}
.mdlx-media-audio{min-height:48px}.mdlx-empty{display:grid;place-items:center;min-height:160px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;padding:24px}
.mdlx-image-modal{width:min(1000px,calc(100vw - 48px))}.mdlx-image-full{display:block;width:100%;max-height:calc(100dvh - 220px);object-fit:contain;border-radius:12px;background:var(--dsw-alias-bg-layer-3)}
.mdlx-hidden{position:absolute!important;width:1px!important;height:1px!important;padding:0!important;margin:-1px!important;overflow:hidden!important;clip:rect(0,0,0,0)!important;white-space:nowrap!important;border:0!important}
.mdlx-textarea:focus-visible,.mdlx-select:focus-visible,.mdlx-native-input:focus-visible,.mdlx-switch:focus-visible,.mdlx-safe-link:focus-visible,.mdlx-modal-content:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
@media (max-width:768px){.mdlx-design{padding:12px}.mdlx-design-shell{grid-template-columns:minmax(0,1fr)}.mdlx-design-pane{padding:12px}.mdlx-resource-list{grid-template-columns:minmax(0,1fr)}}
@media (max-width:560px){.mdlx-modal{width:calc(100vw - 48px)}.mdlx-modal-content{padding:24px}.mdlx-input-row,.mdlx-model-tools{grid-template-columns:minmax(0,1fr)}.mdlx-input-row button,.mdlx-model-tools button,.mdlx-actions button{width:100%}.mdlx-actions{display:grid;grid-template-columns:minmax(0,1fr)}.mdlx-switch-row{grid-template-columns:minmax(0,1fr) 48px}.mdlx-change{grid-template-columns:minmax(0,1fr)}}
@media (pointer:coarse){.mdlx-switch,.mdlx-safe-link{min-width:48px;min-height:48px}.mdlx-actions button{min-height:48px}}
@media (prefers-reduced-motion:reduce){.mdlx-settings *,.mdlx-design *,.mdlx-modal-content *{animation:none!important;transition:none!important;scroll-behavior:auto!important}}
@media (forced-colors:active){.mdlx-card,.mdlx-switch-row,.mdlx-design-pane,.mdlx-result-card,.mdlx-proposal{forced-color-adjust:auto;border-color:CanvasText}.mdlx-textarea,.mdlx-select,.mdlx-native-input{border-color:CanvasText}.mdlx-safe-link{color:LinkText}}
`;

export function installModellixClientStyles(
  target: Document | undefined = typeof document === "undefined" ? undefined : document,
): () => void {
  if (target === undefined) return () => undefined;
  const element = target.createElement("style");
  element.setAttribute("data-dsh-modellix", "client");
  element.textContent = MODELLIX_CLIENT_CSS;
  target.head.append(element);
  return () => element.remove();
}
