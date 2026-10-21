/* OpenGSO website. Progressive touches only: every page reads in full with this file blocked. */
(function () {
  'use strict';

  var root = document.documentElement;
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  root.classList.add('js');

  // Reveal on scroll. Whatever is already on screen is marked visible before .js-reveal hides the
  // rest, so the first paint never blinks and a page without IntersectionObserver loses nothing.
  var revealable = document.querySelectorAll('.reveal, .panel, .bar-chart');
  if ('IntersectionObserver' in window && !reduceMotion) {
    document.querySelectorAll('.grid-2, .grid-3').forEach(function (grid) {
      Array.prototype.forEach.call(grid.children, function (child, i) {
        if (child.classList.contains('reveal')) child.style.transitionDelay = i * 90 + 'ms';
      });
    });
    var fold = window.innerHeight * 0.92;
    revealable.forEach(function (el) {
      if (el.getBoundingClientRect().top < fold) el.classList.add('is-visible');
    });
    root.classList.add('js-reveal');
    var seen = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          entry.target.classList.add('is-visible');
          seen.unobserve(entry.target);
        });
      },
      { threshold: 0.18, rootMargin: '0px 0px -8% 0px' },
    );
    revealable.forEach(function (el) {
      if (!el.classList.contains('is-visible')) seen.observe(el);
    });
  }
  if (reduceMotion) {
    document.querySelectorAll('svg').forEach(function (svg) {
      if (typeof svg.pauseAnimations === 'function') svg.pauseAnimations();
    });
  }

  // Navigation: the phone menu, and the section in view.
  var nav = document.querySelector('nav.top');
  var toggle = nav && nav.querySelector('.nav-toggle');
  if (nav && toggle) {
    var setOpen = function (open) {
      nav.classList.toggle('is-open', open);
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    };
    toggle.addEventListener('click', function () {
      setOpen(!nav.classList.contains('is-open'));
    });
    nav.addEventListener('click', function (event) {
      if (event.target.closest('.nav-mobile-panel a')) setOpen(false);
    });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && nav.classList.contains('is-open')) {
        setOpen(false);
        toggle.focus();
      }
    });
    document.addEventListener('click', function (event) {
      if (nav.classList.contains('is-open') && !nav.contains(event.target)) setOpen(false);
    });
  }
  spy(document.querySelectorAll('.nav-links a[href^="#"]'), '-45% 0px -50% 0px', function (link, on) {
    link.classList.toggle('is-active', on);
  });

  // Docs contents: mark the section being read.
  spy(document.querySelectorAll('.toc a[href^="#"]'), '-20% 0px -70% 0px', function (link, on) {
    if (on) link.setAttribute('aria-current', 'true');
    else link.removeAttribute('aria-current');
  });

  function spy(links, rootMargin, mark) {
    if (!links.length || !('IntersectionObserver' in window)) return;
    var byId = {};
    links.forEach(function (link) {
      byId[link.getAttribute('href').slice(1)] = link;
    });
    var current = null;
    var observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          var link = byId[entry.target.id];
          if (!link || link === current) return;
          if (current) mark(current, false);
          mark(link, true);
          current = link;
        });
      },
      { rootMargin: rootMargin },
    );
    Object.keys(byId).forEach(function (id) {
      var section = document.getElementById(id);
      if (section) observer.observe(section);
    });
  }

  // Copying. Buttons ship hidden, so a page without this file never shows one that does nothing.
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
    return new Promise(function (resolve, reject) {
      var area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      var ok = false;
      try {
        ok = document.execCommand('copy');
      } catch (error) {
        ok = false;
      }
      document.body.removeChild(area);
      if (ok) resolve();
      else reject(new Error('copy failed'));
    });
  }
  function flash(button, label, ms) {
    var before = button.getAttribute('data-label') || button.textContent;
    button.setAttribute('data-label', before);
    button.textContent = label;
    button.classList.add('done');
    clearTimeout(button._flash);
    button._flash = setTimeout(function () {
      button.textContent = before;
      button.classList.remove('done');
    }, ms);
  }
  // The text a code block puts on the clipboard: what it shows, minus the "$ " prompts.
  function codeOf(pre) {
    var clone = pre.cloneNode(true);
    clone.querySelectorAll('.prompt').forEach(function (node) {
      node.remove();
    });
    return clone.textContent.replace(/\n+$/, '');
  }

  document.querySelectorAll('.prose pre').forEach(function (pre) {
    if (pre.closest('.code-block, .code-wrap')) return;
    var wrap = document.createElement('div');
    wrap.className = 'code-wrap';
    pre.parentNode.insertBefore(wrap, pre);
    wrap.appendChild(pre);
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'copy-btn';
    button.textContent = 'copy';
    button.hidden = true;
    wrap.appendChild(button);
  });

  document.querySelectorAll('.copy-btn:not(.cite-copy)').forEach(function (button) {
    button.hidden = false;
    button.addEventListener('click', function () {
      var text = button.getAttribute('data-copy');
      if (text === null) {
        var holder = button.closest('.code-block, .code-wrap');
        var pre = holder && holder.querySelector('pre');
        if (!pre) return;
        text = codeOf(pre);
      }
      copyText(text).then(
        function () {
          flash(button, 'copied', 1600);
        },
        function () {
          flash(button, 'select and copy', 1600);
        },
      );
    });
  });

  // Citation formats. Without this file the BibTeX entry is shown on its own, with no tabs.
  var citeBody = document.querySelector('.cite-body');
  var citeCopy = document.querySelector('.cite-copy');
  if (citeBody) {
    var url = 'https://github.com/sherwinvishesh/OpenGSO';
    var formats = {
      bibtex: citeBody.textContent,
      apa: 'Jathanna, S. V. (2026). OpenGSO (Version 0.1.1) [Computer software]. ' + url,
      mla: 'Jathanna, Sherwin Vishesh. OpenGSO. Version 0.1.1, 2026. GitHub, ' + url + '.',
      chicago: 'Jathanna, Sherwin Vishesh. 2026. "OpenGSO." Version 0.1.1. Software. ' + url + '.',
      ieee: 'S. V. Jathanna, "OpenGSO," version 0.1.1, 2026. [Online]. Available: ' + url,
      harvard: 'Jathanna, S.V. (2026) OpenGSO (version 0.1.1) [Computer program]. Available at: ' + url,
      ris: [
        'TY  - COMP',
        'AU  - Jathanna, Sherwin Vishesh',
        'TI  - OpenGSO',
        'PY  - 2026',
        'ET  - 0.1.1',
        'UR  - ' + url,
        'ER  - ',
      ].join('\n'),
    };
    var tabs = document.querySelectorAll('.cite-tab[data-fmt]');
    tabs.forEach(function (tab) {
      tab.addEventListener('click', function () {
        var fmt = tab.getAttribute('data-fmt');
        if (!(fmt in formats)) return;
        tabs.forEach(function (other) {
          var on = other === tab;
          other.classList.toggle('active', on);
          other.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
        citeBody.textContent = formats[fmt];
        // BibTeX and RIS are records and keep the monospace; the rest are sentences.
        citeBody.classList.toggle('prose-cite', fmt !== 'bibtex' && fmt !== 'ris');
      });
    });
    if (citeCopy) {
      citeCopy.hidden = false;
      citeCopy.addEventListener('click', function () {
        copyText(citeBody.textContent).then(
          function () {
            flash(citeCopy, 'Copied', 1500);
          },
          function () {
            flash(citeCopy, 'Select and copy', 1500);
          },
        );
      });
    }
  }
})();
