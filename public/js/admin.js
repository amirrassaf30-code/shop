(() => {
  const $ = s => document.querySelector(s);
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const money = n => Number(n || 0).toLocaleString('fa-IR');
  const CATS = {phone:'گوشی', tablet:'تبلت', accessory:'لوازم جانبی', charger:'شارژر'};
  const STATUSES = ['جدید', 'در حال پردازش', 'ارسال شده', 'تحویل شده', 'لغو شده', 'در انتظار پرداخت', 'پرداخت شده', 'پرداخت ناموفق'];
  let S = {settings: {}, products: [], orders: []};

  const toast = (t, ms = 2500) => { const el = $('#toast'); el.textContent = t; el.hidden = false; clearTimeout(el._t); el._t = setTimeout(() => el.hidden = true, ms); };
  const show = id => ['login', 'panel'].forEach(x => $('#' + x).hidden = x !== id);

  const NO_SERVER = location.protocol === 'file:'
    ? 'این صفحه از فایل مستقیم باز شده است. سرور را اجرا کنید (node server.js) و از http://localhost:3000/admin باز کنید.'
    : 'به سرور وصل نیست. مطمئن شوید node server.js در حال اجراست و این صفحه از همان آدرس باز شده است.';

  async function api(path, method = 'GET', body) {
    let r;
    try {
      r = await fetch('/api/admin' + path, {
        method, credentials: 'same-origin',
        headers: {'Content-Type': 'application/json'},
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch { throw new Error(NO_SERVER); }
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      if (r.status === 401 && path !== '/login') show('login');
      throw new Error(d.error || 'خطا');
    }
    return d;
  }

  async function load() {
    S = await api('/state');
    $('#settingsForm').shop.value = S.settings.shop || '';
    $('#settingsForm').phone.value = S.settings.phone || '';
    $('#settingsForm').intro.value = S.settings.intro || '';
    $('#pTable').innerHTML = S.products.map(p => `
      <tr>
        <td>${esc(p.name)}<div class="muted">${esc(p.brand)} · ${esc(CATS[p.cat] || '')}</div></td>
        <td>${money(p.price)}</td>
        <td>${Number(p.stock)}</td>
        <td><div class="act">
          <button data-edit="${esc(p.id)}">ویرایش</button>
          <button data-del="${esc(p.id)}">حذف</button>
        </div></td>
      </tr>`).join('') || '<tr><td colspan="4" class="muted">محصولی نیست</td></tr>';
    $('#oTable').innerHTML = S.orders.length ? S.orders.slice().reverse().map(o => `
      <tr>
        <td>${esc(o.id)}</td>
        <td>${esc(new Date(o.createdAt).toLocaleString('fa-IR'))}</td>
        <td>${esc(o.name)}<div class="muted">${esc(o.phone)}</div><div class="muted">${esc(o.address)}</div></td>
        <td>${o.items.map(i => esc(i.name) + ' × ' + Number(i.qty)).join('<br>')}</td>
        <td>${money(o.total)}</td>
        <td><select data-status="${esc(o.id)}">${STATUSES.map(s => `<option ${s === o.status ? 'selected' : ''}>${s}</option>`).join('')}</select></td>
      </tr>`).join('') : '<tr><td colspan="6" class="muted">سفارشی ثبت نشده</td></tr>';
  }

  $('#loginForm').addEventListener('submit', async e => {
    e.preventDefault();
    try {
      await api('/login', 'POST', {password: e.target.password.value});
      e.target.reset();
      $('#loginMsg').textContent = '';
      await load();
      show('panel');
    } catch (err) { $('#loginMsg').textContent = err.message; }
  });

  $('#logoutBtn').onclick = async () => {
    await api('/logout', 'POST').catch(() => {});
    show('login');
  };

  $('#settingsForm').addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target;
    try {
      const d = await api('/settings', 'PUT', {shop: f.shop.value, phone: f.phone.value, intro: f.intro.value, newPassword: f.newPassword.value});
      f.newPassword.value = '';
      if (d.passwordChanged) { toast('رمز تغییر کرد. دوباره وارد شوید', 4000); show('login'); }
      else { toast('تنظیمات ذخیره شد'); await load(); }
    } catch (err) { toast(err.message, 4000); }
  });

  $('#pForm').addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target;
    const body = {name: f.name.value, brand: f.brand.value, cat: f.cat.value, price: f.price.value,
      oldPrice: f.oldPrice.value || 0, stock: f.stock.value, img: f.img.value.trim(), desc: f.desc.value};
    try {
      if (f.id.value) await api('/products/' + encodeURIComponent(f.id.value), 'PUT', body);
      else await api('/products', 'POST', body);
      f.reset(); f.id.value = ''; $('#pTitle').textContent = 'افزودن محصول';
      await load(); toast('محصول ذخیره شد');
    } catch (err) { toast(err.message, 4000); }
  });

  $('#imgFile').addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) return toast('حجم تصویر بیش از ۲ مگابایت است', 4000);
    const data = await new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result);
      r.onerror = rej;
      r.readAsDataURL(file);
    });
    try {
      const d = await api('/upload', 'POST', {data});
      $('#pForm').img.value = d.url;
      toast('تصویر آپلود شد');
    } catch (err) { toast(err.message, 4000); }
    e.target.value = '';
  });

  $('#pReset').onclick = () => { $('#pForm').reset(); $('#pForm').id.value = ''; $('#pTitle').textContent = 'افزودن محصول'; };

  $('#pTable').addEventListener('click', async e => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.edit) {
      const p = S.products.find(x => x.id === b.dataset.edit);
      if (!p) return;
      const f = $('#pForm');
      ['id', 'name', 'brand', 'cat', 'price', 'oldPrice', 'stock', 'img', 'desc'].forEach(k => f[k].value = p[k] ?? '');
      $('#pTitle').textContent = 'ویرایش محصول';
      f.scrollIntoView({behavior: 'smooth'});
    }
    if (b.dataset.del && confirm('این محصول حذف شود؟')) {
      try { await api('/products/' + encodeURIComponent(b.dataset.del), 'DELETE'); await load(); toast('حذف شد'); }
      catch (err) { toast(err.message, 4000); }
    }
  });

  $('#oTable').addEventListener('change', async e => {
    const sel = e.target.closest('select[data-status]');
    if (!sel) return;
    try { await api('/orders/' + encodeURIComponent(sel.dataset.status), 'PATCH', {status: sel.value}); toast('وضعیت به‌روز شد'); }
    catch (err) { toast(err.message, 4000); await load(); }
  });

  (async () => {
    try { await load(); show('panel'); }
    catch (e) { $('#loginMsg').textContent = e.message; show('login'); }
  })();
})();
