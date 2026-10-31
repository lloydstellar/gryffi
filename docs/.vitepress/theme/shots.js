// Screenshots of the user guide (see scripts/generate.mjs, withScreenshots).
// Wide screens: the screenshot of the part you are reading stays next to the
// text. Everywhere: pointing at a number in the text, or at a line of the
// numbered list under a screenshot, rings that marker in the screenshot; a
// click keeps it ringed.

const WIDE = '(min-width: 1280px)';

let cleanup = () => {};

export function initShots() {
  cleanup();
  const layout = document.querySelector('.vp-doc .shot-layout');
  if (!layout) return;

  const figures = [...layout.querySelectorAll('.shot-text figure.shot')];
  const panel = layout.querySelector('.shot-panel');
  const wide = window.matchMedia(WIDE);
  const shots = figures.map((figure) => ({
    figure,
    markers: parseMarkers(figure.dataset.markers),
    copy: null
  }));
  let active = -1;
  let pinned = null;

  // Each screenshot gets a ring; the panel gets a copy of each screenshot
  shots.forEach((shot) => {
    addRing(shot.figure);
    shot.copy = shot.figure.cloneNode(true);
    shot.copy.hidden = true;
    panel.appendChild(shot.copy);
  });

  function show(index) {
    if (index === active || !shots[index]) return;
    active = index;
    shots.forEach((shot, i) => { shot.copy.hidden = i !== index; });
  }

  // The screenshot of the part you are reading: the last one above the
  // middle of the window (or the first)
  function follow() {
    if (!wide.matches || pinned) return;
    const line = window.innerHeight * 0.45;
    let index = 0;
    shots.forEach((shot, i) => {
      if (shot.figure.getBoundingClientRect().top < line) index = i;
    });
    show(index);
  }

  function find(number) {
    const index = shots.findIndex((shot) => shot.markers[number]);
    return index === -1 ? null : { index, marker: shots[index].markers[number] };
  }

  function ring(number) {
    layout.querySelectorAll('.shot-ring.is-on').forEach((el) => el.classList.remove('is-on'));
    if (!number) return;
    const found = find(number);
    if (!found) return;
    if (wide.matches) show(found.index);
    const { figure, copy } = shots[found.index];
    for (const target of [figure, copy]) {
      const el = target.querySelector('.shot-ring');
      el.style.left = `${found.marker.x * 100}%`;
      el.style.top = `${found.marker.y * 100}%`;
      el.style.width = `${found.marker.width * 100}%`;
      el.style.height = `${found.marker.height * 100}%`;
      el.classList.add('is-on');
    }
  }

  // The numbered lists under the screenshots point at the markers too
  figures.forEach((figure) => {
    const list = figure.closest('p')?.nextElementSibling || figure.nextElementSibling;
    if (!list || list.tagName !== 'OL') return;
    const start = Number(list.getAttribute('start') || 1);
    [...list.children].forEach((item, i) => {
      item.classList.add('shot-legend-item');
      item.dataset.marker = String(start + i);
    });
  });

  const targets = [...layout.querySelectorAll('.shot-ref, .shot-legend-item')];
  const setPinned = (number) => {
    pinned = number;
    layout.querySelectorAll('.shot-ref').forEach((btn) => {
      const on = btn.dataset.marker === pinned;
      btn.classList.toggle('is-pinned', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  };
  const handlers = targets.map((el) => {
    const number = el.dataset.marker;
    const enter = () => ring(number);
    const leave = () => ring(pinned);
    const click = () => {
      setPinned(pinned === number ? null : number);
      ring(pinned || number);
      if (!pinned) follow();
    };
    el.addEventListener('mouseenter', enter);
    el.addEventListener('mouseleave', leave);
    if (el.tagName === 'BUTTON') {
      el.setAttribute('aria-pressed', 'false');
      el.addEventListener('focus', enter);
      el.addEventListener('blur', leave);
      el.addEventListener('click', click);
    }
    return () => {
      el.removeEventListener('mouseenter', enter);
      el.removeEventListener('mouseleave', leave);
      el.removeEventListener('focus', enter);
      el.removeEventListener('blur', leave);
      el.removeEventListener('click', click);
    };
  });

  let frame = 0;
  const onScroll = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(follow);
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  wide.addEventListener('change', follow);
  follow();
  if (active === -1) show(0);

  cleanup = () => {
    cancelAnimationFrame(frame);
    window.removeEventListener('scroll', onScroll);
    wide.removeEventListener('change', follow);
    handlers.forEach((off) => off());
    cleanup = () => {};
  };
}

function addRing(figure) {
  const holder = figure.querySelector('.shot-image');
  if (!holder || holder.querySelector('.shot-ring')) return;
  const el = document.createElement('span');
  el.className = 'shot-ring';
  el.setAttribute('aria-hidden', 'true');
  holder.appendChild(el);
}

function parseMarkers(json) {
  try {
    return JSON.parse(json || '{}');
  } catch {
    return {};
  }
}
