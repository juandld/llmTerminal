// Drawer backdrop: on mobile, tapping outside any open drawer (Files, Summary,
// Jobs, Tasks, Decisions) closes it — same UX pattern the sidebar has. Without
// this the ~70px strip left of the 85vw drawer was inert and the only exit was
// the small × in the top-right, which David couldn't always reach.
//
// Implementation: one shared backdrop element (in index.html). A MutationObserver
// watches every .drawer + .summary-panel for hidden-class changes; when any is
// open, we set body.drawer-open (CSS shows the backdrop). No need to patch each
// project's five separate toggle functions.

(function initDrawerBackdrop(){
  const DRAWER_SELECTOR = '.drawer, .summary-panel';

  function anyOpen(){
    return !!document.querySelector('.drawer:not(.hidden), .summary-panel:not(.hidden)');
  }

  function syncBodyClass(){
    document.body.classList.toggle('drawer-open', anyOpen());
  }

  // Global: called by the backdrop's onclick.
  window.closeAllDrawers = function(){
    document.querySelectorAll('.drawer:not(.hidden), .summary-panel:not(.hidden)').forEach(d => {
      d.classList.add('hidden');
    });
    syncBodyClass();
    // Persist the Files-drawer state so it doesn't spring back on next refresh.
    try{ localStorage.setItem('llmt_drawer_open', 'false'); }catch{}
  };

  // Defensive force-close: Escape closes any open drawer no matter what state
  // flags or overlays got stuck (backdrop tap is the touch equivalent). The
  // file modal keeps priority — its own Esc handler closes just the modal.
  document.addEventListener('keydown', function(e){
    if(e.key !== 'Escape') return;
    const fm = document.getElementById('file-modal');
    if(fm && fm.classList.contains('open')) return;
    if(anyOpen()) window.closeAllDrawers();
  });

  function attachObservers(){
    const targets = document.querySelectorAll(DRAWER_SELECTOR);
    if(targets.length === 0) return false;
    const observer = new MutationObserver(syncBodyClass);
    targets.forEach(t => observer.observe(t, { attributes: true, attributeFilter: ['class'] }));
    syncBodyClass();
    return true;
  }

  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', attachObservers);
  } else {
    if(!attachObservers()){
      // Drawers may be added by other scripts after our init runs — retry once.
      setTimeout(attachObservers, 100);
    }
  }
})();
