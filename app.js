(() => {
  const $ = s => document.querySelector(s);
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const money = n => Number(n || 0).toLocaleString('fa-IR') + ' تومان';
  const CATS = {phone:'گوشی موبایل', tablet:'تبلت', accessory:'لوازم جانبی', charger:'شارژر و کابل'};
  const safeImg = u => (/^https:\/\//i.test(u || '') || /^\/uploads\/[a-z0-9.]+$/.test(u || '')) ? u : '';

  let S = {settings: {}, products: []};
  let cart = JSON.parse(localStorage.getItem('ms_cart') || '{}');
  let cat = 'all';

  const saveCart = () => localStorage.setItem('ms_cart', JSON.stringify(cart));
  const toast = (t, ms = 2800) => { const el = $('#toast'); el.textContent = t; el.hidden = false; clearTimeout(el._t); el._t = setTimeout(() => el.hidden = true, ms); };

  async function load() {
    try {
      const r = await fetch('/api/shop', {cache: 'no-store'});
      if (!r.ok) throw new Error();
      S = await r.json();
      return true;
    } catch { return false; }
  }

  function applySettings() {
    document.title = S.settings.shop || 'فروشگاه';
    $('#shopName').textContent = S.settings.shop || '';
    $('#footName').textContent = S.settings.shop || '';
    $('#intro').textContent = S.settings.intro || '';
    $('#waFloat').href = `https://wa.me/${encodeURIComponent(S.settings.phone || '')}`;
  }

  function renderChips() {
    $('#chips').innerHTML = ['all', ...Object.keys(CATS)]
      .map(k => `<button class="chip ${k === cat ? 'active' : ''}" data-cat="${k}">${k === 'all' ? 'همه' : CATS[k]}</button>`).join('');
  }

  function card(p) {
    const off = p.oldPrice > p.price ? Math.round(100 - p.price * 100 / p.oldPrice) : 0;
    const img = safeImg(p.img);
    return `<article class="card">
      ${off ? `<span class="badge">${off}٪ تخفیف</span>` : ''}
      <div class="img">${img ? `<img loading="lazy" src="${esc(img)}" alt="${esc(p.name)}">` : '📱'}</div>
      <h3>${esc(p.name)}</h3>
      <p class="muted">${esc(p.brand)} · ${esc(CATS[p.cat] || '')}</p>
      <p class="muted">${esc(p.desc)}</p>
      <div class="price">${off ? `<s>${money(p.oldPrice)}</s>` : ''}<b>${money(p.price)}</b></div>
      <p class="stock ${p.stock > 0 ? '' : 'out'}">${p.stock > 0 ? 'موجودی: ' + Number(p.stock) + ' عدد' : 'ناموجود'}</p>
      <button class="btn" data-add="${esc(p.id)}" ${p.stock > 0 ? '' : 'disabled'}>افزودن به سبد</button>
    </article>`;
  }

  function renderProducts() {
    const q = $('#search').value.trim().toLowerCase();
    const list = S.products.filter(p =>
      (cat === 'all' || p.cat === cat) && (!q || (p.name + ' ' + p.brand).toLowerCase().includes(q)));
    $('#products').innerHTML = list.length ? list.map(card).join('') : '<p class="empty">محصولی یافت نشد</p>';
  }

  function cartLines() {
    return Object.entries(cart).map(([id, qty]) => {
      const p = S.products.find(x => x.id === id);
      return p ? {id, qty, p, sum: p.price * qty} : null;
    }).filter(Boolean);
  }

  function renderCart() {
    const lines = cartLines();
    $('#cartCount').textContent = lines.reduce((s, l) => s + l.qty, 0);
    $('#cartItems').innerHTML = lines.length ? lines.map(l => `
      <div class="row">
        <div><b>${esc(l.p.name)}</b><div class="muted">${money(l.p.price)}</div></div>
        <div class="qty">
          <button data-dec="${esc(l.id)}">−</button><span>${l.qty}</span>
          <button data-inc="${esc(l.id)}" ${l.qty >= l.p.stock ? 'disabled' : ''}>+</button>
          <button data-rm="${esc(l.id)}" title="حذف">🗑</button>
        </div>
      </div>`).join('') : '<p class="empty">سبد خرید خالی است</p>';
    $('#cartTotal').textContent = money(lines.reduce((s, l) => s + l.sum, 0));
  }

  function addToCart(id) {
    const p = S.products.find(x => x.id === id);
    if (!p || p.stock <= 0) return;
    if ((cart[id] || 0) >= p.stock) return toast('موجودی کافی نیست');
    cart[id] = (cart[id] || 0) + 1;
    saveCart(); renderCart(); toast('به سبد اضافه شد');
  }

  function changeQty(id, d) {
    const p = S.products.find(x => x.id === id);
    const n = (cart[id] || 0) + d;
    if (n <= 0 || !p) delete cart[id];
    else if (n > p.stock) return toast('موجودی کافی نیست');
    else cart[id] = n;
    saveCart(); renderCart();
  }

  async function checkout(e) {
    e.preventDefault();
    const f = new FormData(e.target);
    const items = cartLines().map(l => ({id: l.id, qty: l.qty}));
    if (!items.length) return toast('سبد خالی است');
    const btn = e.target.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      const r = await fetch('/api/orders', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({name: f.get('name'), phone: f.get('phone'), address: f.get('address'), pay: f.get('pay'), items}),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) return toast(d.error || 'خطا در ثبت سفارش', 4000);
      cart = {}; saveCart();
      if (d.payUrl) { location.href = d.payUrl; return; }
      $('#cartModal').hidden = true;
      e.target.reset();
      toast(`سفارش ثبت شد. کد پیگیری: ${d.id}`, 7000);
      if (await load()) { renderProducts(); renderCart(); }
    } catch {
      toast('ارتباط با سرور برقرار نشد', 4000);
    } finally {
      btn.disabled = false;
    }
  }

  document.addEventListener('click', e => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.add) addToCart(t.dataset.add);
    else if (t.dataset.inc) changeQty(t.dataset.inc, 1);
    else if (t.dataset.dec) changeQty(t.dataset.dec, -1);
    else if (t.dataset.rm) { delete cart[t.dataset.rm]; saveCart(); renderCart(); }
    else if (t.dataset.cat) { cat = t.dataset.cat; renderChips(); renderProducts(); }
  });
  $('#search').addEventListener('input', renderProducts);
  $('#openCart').onclick = () => { renderCart(); $('#cartModal').hidden = false; };
  $('#closeCart').onclick = () => $('#cartModal').hidden = true;
  $('#cartModal').addEventListener('click', e => { if (e.target.id === 'cartModal') e.target.hidden = true; });
  $('#checkout').addEventListener('submit', checkout);

  async function init() {
    if (!await load()) {
      const msg = location.protocol === 'file:'
        ? 'این صفحه از فایل مستقیم باز شده است. ابتدا سرور را اجرا کنید (node server.js) و سپس http://localhost:3000 را باز کنید.'
        : 'به سرور وصل نیست. مطمئن شوید سرور (node server.js) در حال اجراست و این صفحه از همان آدرس باز شده است.';
      $('#products').innerHTML = `<p class="empty">${msg}</p>`;
      return;
    }
    const paid = new URLSearchParams(location.search).get('paid');
    if (paid) {
      toast(paid === 'fail' ? 'پرداخت ناموفق بود یا لغو شد' : `پرداخت انجام شد. کد سفارش: ${paid}`, 8000);
      history.replaceState(null, '', '/');
    }
    applySettings(); renderChips(); renderProducts(); renderCart();
    setInterval(async () => { if (await load()) { renderProducts(); renderCart(); } }, 60000);
  }
  init();
})();
