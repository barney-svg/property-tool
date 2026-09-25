// Rightmove links are detail-only: no valuation estimate or comparable analysis.
(() => {
  const originalAnalyse = analyse;
  const originalSetMode = setMode;

  function setRightmoveLayout(enabled) {
    document.body.classList.toggle('rightmove-detail-mode', Boolean(enabled));

    const estimateCard = document.querySelector('.hero-card#overview');
    const soldCard = document.getElementById('sold-comps');
    const marketCard = document.getElementById('marketCard');
    const methodology = document.querySelector('.methodology-card');
    const nav = document.querySelector('.result-nav');
    const overviewLink = nav?.querySelector('a[href="#overview"], a[data-overview-link]');
    const soldLink = nav?.querySelector('a[href="#sold-comps"]');
    const marketLink = nav?.querySelector('a[href="#marketCard"]');

    if (overviewLink) {
      overviewLink.dataset.overviewLink = '1';
      overviewLink.href = enabled ? '#property-profile' : '#overview';
      overviewLink.textContent = enabled ? 'Property' : 'Overview';
    }

    if (enabled) {
      estimateCard?.classList.add('hidden');
      soldCard?.classList.add('hidden');
      marketCard?.classList.add('hidden');
      methodology?.classList.add('hidden');
      soldLink?.classList.add('hidden');
      marketLink?.classList.add('hidden');
    } else {
      estimateCard?.classList.remove('hidden');
      soldCard?.classList.remove('hidden');
      methodology?.classList.remove('hidden');
      soldLink?.classList.remove('hidden');
      marketLink?.classList.remove('hidden');
      // marketCard is intentionally not force-shown here; normal comparable rendering controls it.
    }
  }

  setMode = function(mode) {
    originalSetMode(mode);
    setRightmoveLayout(mode === 'rightmove');
  };

  analyse = async function(manual, listing = null, options = {}) {
    if (!listing) {
      setRightmoveLayout(false);
      return originalAnalyse(manual, listing, options);
    }

    // Rightmove listing mode deliberately skips Land Registry valuation work and
    // all sold/live comparable searches. This keeps link lookups substantially faster.
    const token = ++state.analysisToken;
    clearError();
    state.lastEpc = null;
    state.lastSubject = null;
    state.lastEstimate = null;

    $('results')?.classList.remove('hidden');
    showImmediateProperty(manual, listing);
    setRightmoveLayout(true);
    setStatus('Working', 'loading');
    setLoading(true, 'Loading property details…', 'Checking EPC and local property information.');

    runPropertyExtras(manual, listing, token).catch(() => {});

    try {
      const epc = await loadEpc(manual, listing).catch(() => null);
      if (token !== state.analysisToken) return;
      state.lastEpc = epc;
      renderFacts(manual, epc, null, listing, null);
      setRightmoveLayout(true);
      setStatus('Ready', 'good');
    } catch (error) {
      if (token !== state.analysisToken) return;
      // Keep the listing details visible even if EPC enrichment fails.
      renderFacts(manual, null, null, listing, null);
      setRightmoveLayout(true);
      setStatus('Ready', 'good');
    } finally {
      if (token === state.analysisToken) setLoading(false);
    }
  };

  // Apply the correct layout on initial load as well.
  setRightmoveLayout(state?.mode === 'rightmove');
})();