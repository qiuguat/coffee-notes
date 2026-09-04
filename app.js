// Trade Log app logic (Vue 3, no build tools).
// Sections: config -> data -> computed -> mounted -> methods (calc() holds the money formulas).

const { createApp } = Vue;

// ============ CLOUD DATABASE (Supabase) — your project ============
const SUPABASE_URL = "https://rrwyehoprmglkwlhlnqj.supabase.co";
const SUPABASE_KEY = "sb_publishable_24kWt2sSn-vJ5UspAgfqug_Uz6mOkgY"; // publishable key — safe to be public; RLS protects the data
let sb = null; // supabase client (kept outside Vue)
const INDUSTRIES_ROW_ID = "__industries"; // special row that syncs your industry list

const blankFill = () => ({ units: "", price: "", fee: "", at: "" });

// blank position template
const EMPTY = () => ({
  market: "MY", name: "", industry: "",
  buys: [blankFill()], sells: [],
  stop: "", shots: [],
  reasonBuy: "", reasonSell: "", remarks: "",
  sigMacd: false, sigSar: false, sigRsi: false, sigVol: false,
});

const DEFAULT_INDUSTRIES = ["Semiconductor","Technology","Finance","Consumer","Utilities","Property","Telecommunication","Construction","Plantation","Healthcare","Energy","Industrial","REIT"];

createApp({
  data() {
    return {
      positions: [],
      industries: DEFAULT_INDUSTRIES.slice(),
      hasStorage: typeof window.storage !== "undefined",
      cloud: false,       // supabase library loaded and client created
      cloudSkip: false,   // user chose to work offline
      user: null,         // signed-in supabase user
      sync: "",           // sync status text shown in the header
      authEmail: "", authPass: "", authError: "", authBusy: false,
      saveError: false,
      busy: null,
      showForm: false, showInd: false,
      editId: null, expanded: null, newInd: "",
      confirmDel: null,
      openMonths: {},
      marketTab: "MY", // which market is showing in the trade log
      view: "log",       // 'log' | 'dashboard' | 'stock'
      dashMarket: "MY",  // which market the dashboard shows
      dashOpen: true,    // sidebar Dashboard submenu expanded
      stockOpen: true,   // sidebar Stock submenu expanded
      stockView: "list", // 'list' | 'details'
      stockMarket: "MY", // market shown in the stock pages
      stockSel: "",      // selected stock name for details
      stockPage: 1,      // stock list pagination (30 per page)
      stockSearch: "",   // stock list search box
      shotUrls: {},      // screenshot path -> temporary signed URL
      shotBusy: false,   // a screenshot upload is in progress
      shotErr: "",       // last screenshot storage error, shown at the field
      logOpen: true,   // sidebar Trade log submenu expanded
      sideOpen: true,  // sidebar expanded (<< / >>)
      theme: "light",  // 'light' or 'dark'
      calYear: new Date().getFullYear(),
      calSel: new Date().getFullYear() + "-" + String(new Date().getMonth() + 1).padStart(2, "0"),
      form: EMPTY(),
    };
  },

  computed: {
    sortedIndustries() {
      return [...this.industries].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
    },
    coreCount() {
      return (this.form.sigMacd ? 1 : 0) + (this.form.sigSar ? 1 : 0) + (this.form.sigRsi ? 1 : 0);
    },
    // live calculation of the form being edited
    fc() { return this.calc(this.form); },

    // 1:2R plan numbers, based on average cost and the cut loss price
    pc() {
      const entry = this.fc.avgCost, stop = this.num(this.form.stop);
      const valid = this.form.stop !== "" && entry > 0 && stop > 0 && stop < entry;
      if (!valid) return { valid: false };
      const risk = entry - stop;
      return {
        valid: true, risk,
        t1: entry + risk, t2: entry + 2 * risk,
        totalRisk: risk * this.fc.buyUnits,
        totalReward: 2 * risk * this.fc.buyUnits,
      };
    },

    // positions of the active market tab
    // per-month stats for the sidebar calendar, for the selected market
    calMonths() {
      const map = {};
      this.positions.forEach((p) => {
        if ((p.market || "MY") !== this.marketTab) return;
        const c = this.calc(p);
        if (!c.firstBuyAt) return;
        const d = new Date(c.firstBuyAt);
        if (isNaN(d)) return;
        const key = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
        if (!map[key]) map[key] = { pl: 0, wins: 0, losses: 0 };
        if (c.status !== "closed") return;
        map[key].pl += c.pl;
        if (c.pl >= 0) map[key].wins++; else map[key].losses++;
      });
      return map;
    },
    calSummary() {
      const [y, m] = this.calSel.split("-");
      const title = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][parseInt(m, 10) - 1] + " " + y;
      const s = this.calMonths[this.calSel];
      if (!s || s.wins + s.losses === 0) return { title, has: false };
      const n = s.wins + s.losses;
      return { title, has: true, pl: s.pl, wins: s.wins, losses: s.losses, winRate: Math.round((s.wins / n) * 100) };
    },

    headSub() {
      if (this.view === "dashboard") return "Dashboard · " + this.dashMarket;
      if (this.view === "stock") return this.stockView === "details" && this.stockSel ? "Stock · " + this.stockSel : "Stock list · " + this.stockMarket;
      return this.marketTab === "MY" ? "Malaysia (MYR)" : "United States (USD)";
    },
    stockRows() {
      const rows = this.dashTiming[this.stockMarket];
      const q = this.stockSearch.trim().toUpperCase();
      return q ? rows.filter((r) => r.name.toUpperCase().includes(q)) : rows;
    },
    stockPages() { return Math.max(1, Math.ceil(this.stockRows.length / 30)); },
    stockPageRows() {
      const page = Math.min(this.stockPage, this.stockPages);
      return this.stockRows.slice((page - 1) * 30, page * 30);
    },
    stockPositions() {
      if (!this.stockSel) return [];
      const key = this.stockSel.toUpperCase();
      return this.positions
        .filter((p) => (p.market || "MY") === this.stockMarket && (p.name || "").toUpperCase() === key)
        .sort((a, b) => {
          const ta = this.calc(a).firstBuyAt, tb = this.calc(b).firstBuyAt;
          return (tb ? new Date(tb).getTime() : 0) - (ta ? new Date(ta).getTime() : 0);
        });
    },
    stockAgg() {
      const row = this.stockRows.find((r) => r.name.toUpperCase() === this.stockSel.toUpperCase()) || {};
      let wins = 0, losses = 0, openN = 0;
      this.stockPositions.forEach((p) => {
        const c = this.calc(p);
        if (c.status !== "closed") { openN++; return; }
        if (c.pl >= 0) wins++; else losses++;
      });
      const n = wins + losses;
      return { n: this.stockPositions.length, openN, wins, losses,
               winRate: n ? Math.round((wins / n) * 100) : null,
               pl: row.pl || 0, hasPl: !!row.hasPl,
               buyT: row.buyT || "", sellT: row.sellT || "", held: row.held || "" };
    },

    // equity curve per market: cumulative P/L of closed positions, in close-date order
    dashEq() {
      const build = (m) => {
        const rows = this.positions
          .filter((p) => (p.market || "MY") === m)
          .map((p) => ({ p, c: this.calc(p) }))
          .filter((x) => x.c.status === "closed" && x.c.lastSellAt)
          .sort((a, b) => new Date(a.c.lastSellAt) - new Date(b.c.lastSellAt));
        if (!rows.length) return { has: false };
        let cum = 0;
        const raw = rows.map((x, i) => { cum += x.c.pl; return { i, cum, date: x.c.lastSellAt, name: x.p.name }; });
        const W = 600, H = 170, padT = 10, padB = 8, padL = 6, padR = 6;
        const lo = Math.min(0, ...raw.map((r) => r.cum));
        const hi = Math.max(0, ...raw.map((r) => r.cum));
        const span = (hi - lo) || 1;
        const xf = (i) => raw.length === 1 ? W / 2 : padL + (W - padL - padR) * i / (raw.length - 1);
        const yf = (v) => padT + (H - padT - padB) * (1 - (v - lo) / span);
        const path = raw.map((r, i) => (i ? "L" : "M") + xf(r.i).toFixed(1) + " " + yf(r.cum).toFixed(1)).join(" ");
        const dOnly = (s) => this.dt(s).split(" ")[0];
        return {
          has: true, W, H, path, zeroY: yf(0).toFixed(1),
          pts: raw.map((r) => ({ cx: xf(r.i).toFixed(1), cy: yf(r.cum).toFixed(1), title: dOnly(r.date) + " " + r.name + " → " + this.money(r.cum, m) })),
          final: raw[raw.length - 1].cum,
          startLabel: dOnly(raw[0].date), endLabel: dOnly(raw[raw.length - 1].date),
        };
      };
      return { MY: build("MY"), US: build("US") };
    },

    // per-stock timing: average clock time of buys and sells (midnight-only times from old
    // date-only Excel rows are ignored so they don't drag the average to 00:00)
    dashTiming() {
      const build = (m) => {
        const map = {};
        this.positions.forEach((p) => {
          if ((p.market || "MY") !== m || !p.name) return;
          const key = p.name.toUpperCase();
          if (!map[key]) map[key] = { name: p.name, n: 0, buyMins: [], sellMins: [], heldMs: [], pl: 0, hasPl: false };
          const s = map[key];
          s.n++;
          const mins = (at) => {
            if (!at) return null;
            const d = new Date(at);
            if (isNaN(d)) return null;
            if (d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0) return null; // date-only rows
            return d.getHours() * 60 + d.getMinutes();
          };
          (p.buys || []).forEach((f) => { const v = mins(f.at); if (v !== null) s.buyMins.push(v); });
          (p.sells || []).forEach((f) => { const v = mins(f.at); if (v !== null) s.sellMins.push(v); });
          const c = this.calc(p);
          if (c.status === "closed") {
            s.pl += c.pl; s.hasPl = true;
            if (c.firstBuyAt && c.lastSellAt) {
              const ms = new Date(c.lastSellAt) - new Date(c.firstBuyAt);
              if (ms >= 0) s.heldMs.push(ms);
            }
          }
        });
        const avg = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
        const tFmt = (v) => v === null ? "" : String(Math.floor(v / 60)).padStart(2, "0") + ":" + String(Math.round(v % 60)).padStart(2, "0");
        const hFmt = (v) => {
          if (v === null) return "";
          const d = Math.floor(v / 86400000), h = Math.floor((v % 86400000) / 3600000), mi = Math.floor((v % 3600000) / 60000);
          return d > 0 ? d + "d " + h + "h" : (h > 0 ? h + "h " + mi + "m" : mi + "m");
        };
        return Object.values(map)
          .map((s) => ({ name: s.name, n: s.n, buyT: tFmt(avg(s.buyMins)), sellT: tFmt(avg(s.sellMins)), held: hFmt(avg(s.heldMs)), pl: s.pl, hasPl: s.hasPl }))
          .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
      };
      return { MY: build("MY"), US: build("US") };
    },

    // dashboard stats across ALL positions, per market
    dash() {
      const mk = () => ({ pl: 0, fees: 0, wins: 0, losses: 0, open: 0, winRate: null });
      const d = { MY: mk(), US: mk() };
      this.positions.forEach((p) => {
        const c = this.calc(p);
        const s = d[(p.market || "MY") === "US" ? "US" : "MY"];
        s.fees += c.buyFees + c.sellFees;
        if (c.status !== "closed") { s.open++; return; }
        s.pl += c.pl;
        if (c.pl >= 0) s.wins++; else s.losses++;
      });
      ["MY", "US"].forEach((m) => {
        const n = d[m].wins + d[m].losses;
        d[m].winRate = n ? Math.round((d[m].wins / n) * 100) : null;
      });
      return d;
    },

    filtered() {
      return this.positions.filter((p) => (p.market || "MY") === this.marketTab);
    },

    // active tab's positions sorted by first buy date, grouped by month — oldest first
    grouped() {
      const withDate = (p) => {
        const c = this.calc(p);
        return c.firstBuyAt ? new Date(c.firstBuyAt).getTime() : 0;
      };
      const sorted = [...this.filtered].sort((a, b) => withDate(a) - withDate(b));
      const groups = [];
      let cur = null;
      sorted.forEach((p) => {
        const at = this.calc(p).firstBuyAt;
        const d = at ? new Date(at) : null;
        const valid = d && !isNaN(d);
        const key = valid ? d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") : "undated";
        const label = valid ? d.toLocaleDateString("en-MY", { month: "long", year: "numeric" }) : "No buy date";
        if (!cur || cur.key !== key) { cur = { key, label, items: [] }; groups.push(cur); }
        cur.items.push(p);
      });
      return groups;
    },
  },

  async mounted() {
    try { const t = localStorage.getItem("theme"); if (t === "dark" || t === "light") this.theme = t; } catch (e) { /* default light */ }
    try { const s = localStorage.getItem("sideOpen"); if (s === "0") this.sideOpen = false; } catch (e) { /* default open */ }
    this.applyTheme();

    if (this.hasStorage) {
      try {
        const r = await window.storage.get("positions-v1");
        if (r && r.value) this.positions = JSON.parse(r.value);
      } catch (e) {
        // no v1 positions yet — try migrating from the old single-fill format
        try {
          const old = await window.storage.get("trades-v2");
          if (old && old.value) {
            const trades = JSON.parse(old.value);
            this.positions = trades.map((t) => this.migrateOld(t));
            await this.persist();
          }
        } catch (e2) { /* first run */ }
      }
      try {
        const r = await window.storage.get("industries-v1");
        if (r && r.value) this.industries = JSON.parse(r.value);
      } catch (e) { /* first run */ }
    }

    // ----- cloud database -----
    if (window.supabase) {
      try {
        // some environments block localStorage — give supabase an in-memory fallback so it never crashes
        let authStorage;
        try { localStorage.setItem("__t", "1"); localStorage.removeItem("__t"); }
        catch (e) {
          const mem = {};
          authStorage = { getItem: (k) => mem[k] ?? null, setItem: (k, v) => { mem[k] = v; }, removeItem: (k) => { delete mem[k]; } };
        }
        sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, authStorage ? { auth: { storage: authStorage } } : {});
        this.cloud = true;
        const { data } = await sb.auth.getSession();
        this.user = data && data.session ? data.session.user : null;
        sb.auth.onAuthStateChange((_e, session) => { this.user = session ? session.user : null; });
        if (this.user) await this.loadCloud();
      } catch (e) { this.cloud = false; }
    }
  },

  methods: {
    blankFill,

    planText(p) {
      if (p.stop !== "" && p.stop !== undefined && p.stop !== null && this.num(p.stop) > 0) return "Cut loss @ " + this.priceN(this.num(p.stop));
      return "";
    },

    // convert an old single-fill trade record into a position
    migrateOld(t) {
      return {
        id: t.id || Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        market: t.market || "MY", name: t.name || "", industry: t.industry || "",
        buys: [{ units: t.units || "", price: t.entryPrice || "", fee: t.buyFee || "", at: t.buyAt || "" }],
        sells: (t.sellPrice !== "" && t.sellPrice !== undefined && t.sellPrice !== null)
          ? [{ units: t.units || "", price: t.sellPrice, fee: t.sellFee || "", at: t.sellAt || "" }] : [],
        reasonBuy: t.reasonBuy || "", reasonSell: t.reasonSell || "", remarks: t.remarks || "",
        stop: "", shots: [],
        sigMacd: !!t.sigMacd, sigSar: !!t.sigSar, sigRsi: !!t.sigRsi, sigVol: !!t.sigVol,
      };
    },

    // signals scorecard for one market: win rate by core signals (MACD/SAR/RSI) ticked at entry
    sigScoreFor(market) {
      const mk = (label) => ({ label, n: 0, wins: 0, pctSum: 0 });
      const b3 = mk("3/3 core signals"), b2 = mk("2/3 core signals"), b1 = mk("0–1/3 core signals");
      const vy = mk("Volume confirmed (MAVOL)"), vn = mk("Volume not confirmed");
      this.positions.forEach((p) => {
        if ((p.market || "MY") !== market) return;
        const c = this.calc(p);
        if (c.status !== "closed" || !c.totalBuyCost) return;
        const core = (p.sigMacd ? 1 : 0) + (p.sigSar ? 1 : 0) + (p.sigRsi ? 1 : 0);
        const bucket = core === 3 ? b3 : core === 2 ? b2 : b1;
        const vol = p.sigVol ? vy : vn;
        [bucket, vol].forEach((s) => {
          s.n++;
          if (c.pl >= 0) s.wins++;
          s.pctSum += (c.pl / c.totalBuyCost) * 100;
        });
      });
      return [b3, b2, b1, vy, vn].map((s) => ({
        label: s.label, n: s.n,
        winRate: s.n ? Math.round((s.wins / s.n) * 100) : null,
        avgPct: s.n ? s.pctSum / s.n : 0,
      }));
    },
    // ---------- screenshots (Supabase Storage) ----------
    toggleExpand(p) {
      this.expanded = this.expanded === p.id ? null : p.id;
      if (this.expanded && p.shots && p.shots.length) this.loadShotUrls(p.shots);
    },
    async loadShotUrls(shots) {
      if (!sb || !this.user) return;
      const missing = shots.map((s) => s.path).filter((path) => !this.shotUrls[path]);
      if (!missing.length) return;
      try {
        const { data, error } = await sb.storage.from("screenshots").createSignedUrls(missing, 86400);
        if (error) throw error;
        (data || []).forEach((d) => {
          if (d.signedUrl) this.shotUrls[d.path] = d.signedUrl;
          else if (d.error) this.shotErr = "preview: " + d.error;
        });
      } catch (e) { this.shotErr = "preview: " + (e.message || e); }
    },
    viewShot(path) {
      const url = this.shotUrls[path];
      if (url) window.open(url, "_blank");
    },
    compressImage(file) {
      // resize to max 1400px and re-encode as JPEG ~85% so each screenshot is ~150-300KB
      return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          const max = 1400;
          const scale = Math.min(1, max / Math.max(img.width, img.height));
          const canvas = document.createElement("canvas");
          canvas.width = Math.round(img.width * scale);
          canvas.height = Math.round(img.height * scale);
          canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
          canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("compress failed")), "image/jpeg", 0.85);
          URL.revokeObjectURL(img.src);
        };
        img.onerror = () => reject(new Error("not an image"));
        img.src = URL.createObjectURL(file);
      });
    },
    async addShots(e) {
      const files = [...(e.target.files || [])];
      e.target.value = "";
      if (!files.length || !sb || !this.user) return;
      this.shotBusy = true;
      this.shotErr = "";
      if (!this.form.shots) this.form.shots = [];
      try {
        for (const file of files) {
          const blob = await this.compressImage(file);
          const path = this.user.id + "/" + (this.editId || "new") + "-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6) + ".jpg";
          const { error } = await sb.storage.from("screenshots").upload(path, blob, { contentType: "image/jpeg" });
          if (error) throw error;
          this.form.shots.push({ path });
        }
        await this.loadShotUrls(this.form.shots);
      } catch (err) { this.shotErr = "upload: " + (err.message || err); }
      this.shotBusy = false;
    },
    async removeShot(i) {
      const s = this.form.shots[i];
      this.form.shots.splice(i, 1);
      if (sb && this.user && s) {
        try { await sb.storage.from("screenshots").remove([s.path]); } catch (e) { /* orphan file, harmless */ }
      }
    },

    openStock(name) {
      this.stockSel = name;
      this.stockView = "details";
      this.view = "stock";
      this.expanded = null;
    },

    // ---------- sidebar + calendar ----------
    toggleSide() {
      this.sideOpen = !this.sideOpen;
      try { localStorage.setItem("sideOpen", this.sideOpen ? "1" : "0"); } catch (e) { /* fine */ }
    },
    calKey(i) { return this.calYear + "-" + String(i + 1).padStart(2, "0"); },
    calCellClass(i) {
      const key = this.calKey(i);
      const s = this.calMonths[key];
      const cls = [];
      if (s && s.wins + s.losses > 0) cls.push(s.pl >= 0 ? "win" : "loss");
      if (key === this.calSel) cls.push("sel");
      return cls.join(" ");
    },
    pickMonth(i) {
      const key = this.calKey(i);
      this.calSel = key;
      this.view = "log";
      this.openMonths = { [key]: true }; // open that month in the trade log, close all others
    },

    // ---------- theme ----------
    applyTheme() {
      document.documentElement.setAttribute("data-theme", this.theme);
    },
    toggleTheme() {
      this.theme = this.theme === "dark" ? "light" : "dark";
      this.applyTheme();
      try { localStorage.setItem("theme", this.theme); } catch (e) { /* storage blocked — theme resets next visit */ }
    },

    // ---------- month expand / collapse ----------
    toggleMonth(key) { this.openMonths[key] = !this.openMonths[key]; },
    isOpen(key) { return !!this.openMonths[key]; },

    // ---------- number / date helpers ----------
    num(v) { const n = parseFloat(v); return isNaN(n) ? 0 : n; },
    units(v) { const n = parseFloat(v); return isNaN(n) ? "—" : n.toLocaleString("en-MY"); },
    priceN(n) {
      if (n === null || n === undefined || isNaN(n)) return "—";
      return n.toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
    },
    money(n, market) {
      if (n === null || n === undefined || isNaN(n)) return "—";
      const sym = market === "MY" ? "RM " : "$";
      return (n < 0 ? "-" : "") + sym + Math.abs(n).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    },
    pctText(pl, base) {
      if (!base) return "—";
      return ((pl / base) * 100).toFixed(2) + "%";
    },
    tone(n) { return n > 0 ? "c-win" : n < 0 ? "c-loss" : ""; },
    dt(s) {
      // display format: dd/mm/yyyy hh:mm:ss
      if (!s) return "—";
      const d = new Date(s);
      if (isNaN(d)) return "—";
      const p = (n) => String(n).padStart(2, "0");
      return p(d.getDate()) + "/" + p(d.getMonth() + 1) + "/" + d.getFullYear() + " " +
             p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
    },
    // dd/mm/yyyy input helpers — stored internally as ISO so all math keeps working
    dmy(s) {
      if (!s) return "";
      const d = new Date(s);
      if (isNaN(d)) return "";
      const p = (n) => String(n).padStart(2, "0");
      return p(d.getDate()) + "/" + p(d.getMonth() + 1) + "/" + d.getFullYear() + " " +
             p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
    },
    parseDmy(v) {
      v = String(v).trim();
      if (!v) return "";
      const m = v.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
      if (!m) return "";
      const dd = +m[1], mm = +m[2], yy = +m[3], hh = +(m[4] || 0), mi = +(m[5] || 0), ss = +(m[6] || 0);
      const d = new Date(yy, mm - 1, dd, hh, mi, ss);
      if (isNaN(d) || d.getDate() !== dd || d.getMonth() !== mm - 1) return "";
      const p = (n) => String(n).padStart(2, "0");
      return yy + "-" + p(mm) + "-" + p(dd) + "T" + p(hh) + ":" + p(mi) + ":" + p(ss);
    },
    nowIso() {
      const d = new Date();
      const p = (n) => String(n).padStart(2, "0");
      return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + "T" +
             p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
    },
    durationMs(ms) {
      const d = Math.floor(ms / 86400000); ms -= d * 86400000;
      const h = Math.floor(ms / 3600000); ms -= h * 3600000;
      const m = Math.floor(ms / 60000); ms -= m * 60000;
      const s = Math.floor(ms / 1000);
      return { d, h, m, s, text: d + "d " + h + "h " + m + "m " + s + "s" };
    },
    signalText(p) {
      const parts = [];
      if (p.sigMacd) parts.push("MACD golden cross");
      if (p.sigSar) parts.push("SAR green");
      if (p.sigRsi) parts.push("RSI > 50");
      if (p.sigVol) parts.push("Volume confirmed");
      return parts.join(", ");
    },

    // ---------- position math — the heart of the app ----------
    // avg cost = pure weighted price (fees NOT inside the average, matching Moomoo display)
    // totals   = value + fees, matching your Excel
    calc(p) {
      const live = (f) => this.num(f.units) > 0 && f.price !== "" && f.price !== null && f.price !== undefined;
      const buys = (p.buys || []).filter(live);
      const sells = (p.sells || []).filter(live);

      const buyUnits = buys.reduce((s, f) => s + this.num(f.units), 0);
      const buyGross = buys.reduce((s, f) => s + this.num(f.units) * this.num(f.price), 0);
      const buyFees = (p.buys || []).reduce((s, f) => s + this.num(f.fee), 0);
      const sellUnits = sells.reduce((s, f) => s + this.num(f.units), 0);
      const sellGross = sells.reduce((s, f) => s + this.num(f.units) * this.num(f.price), 0);
      const sellFees = sells.reduce((s, f) => s + this.num(f.fee), 0);

      const avgCost = buyUnits ? buyGross / buyUnits : 0;
      const avgSell = sellUnits ? sellGross / sellUnits : null;
      const totalBuyCost = buyGross + buyFees;
      const totalSellCost = sellUnits ? sellGross + sellFees : null;

      const status = sellUnits <= 0 ? "open" : (sellUnits >= buyUnits ? "closed" : "partial");
      // full position P/L: everything received minus everything paid (all fees included)
      const pl = status === "closed" ? sellGross - sellFees - totalBuyCost : null;
      // realized P/L while partially sold: sold units measured against average cost
      const realized = status === "partial" ? sellGross - sellFees - sellUnits * avgCost : null;

      const buyTimes = buys.map((f) => new Date(f.at).getTime()).filter((t) => !isNaN(t));
      const sellTimes = sells.map((f) => new Date(f.at).getTime()).filter((t) => !isNaN(t));
      const firstBuyAt = buyTimes.length ? new Date(Math.min(...buyTimes)).toISOString() : null;
      const lastSellAt = sellTimes.length ? new Date(Math.max(...sellTimes)).toISOString() : null;
      let dur = null, days = null;
      if (status === "closed" && firstBuyAt && lastSellAt) {
        const ms = new Date(lastSellAt) - new Date(firstBuyAt);
        if (ms >= 0) { dur = this.durationMs(ms); days = dur.d; }
      }

      return { buyUnits, buyGross, buyFees, sellUnits, sellGross, sellFees,
               avgCost, avgSell, totalBuyCost, totalSellCost, status, pl, realized,
               firstBuyAt, lastSellAt, dur, days };
    },

    rowClass(p) {
      const c = this.calc(p);
      if (c.status !== "closed") return "row-open";
      return c.pl >= 0 ? "row-win" : "row-loss";
    },
    unitsCell(p) {
      const c = this.calc(p);
      if (c.status === "partial") return this.units(c.sellUnits) + " / " + this.units(c.buyUnits);
      return this.units(c.buyUnits || "");
    },
    plCell(p) {
      const c = this.calc(p);
      if (c.status === "closed") return this.money(c.pl, p.market);
      if (c.status === "partial") return this.money(c.realized, p.market);
      return "open";
    },
    plCellClass(p) {
      const c = this.calc(p);
      if (c.status === "closed") return c.pl >= 0 ? "c-win" : "c-loss";
      if (c.status === "partial") return c.realized >= 0 ? "c-win" : "c-loss";
      return "pl-open";
    },
    pctCell(p) {
      const c = this.calc(p);
      if (c.status === "closed") return this.pctText(c.pl, c.totalBuyCost);
      return "—";
    },

    // monthly subtotal (single currency — the group only holds the active tab's market)
    mSum(g) {
      const s = { fees: 0, pl: 0, wins: 0, losses: 0 };
      g.items.forEach((p) => {
        const c = this.calc(p);
        s.fees += c.buyFees + c.sellFees;
        if (c.status !== "closed") return;
        s.pl += c.pl;
        if (c.pl >= 0) s.wins++; else s.losses++;
      });
      const n = s.wins + s.losses;
      s.winRate = n ? Math.round((s.wins / n) * 100) : null;
      return s;
    },

    // ---------- cloud: auth ----------
    async signIn() {
      if (!sb) return;
      this.authBusy = true; this.authError = "";
      const { error } = await sb.auth.signInWithPassword({ email: this.authEmail.trim(), password: this.authPass });
      this.authBusy = false;
      if (error) { this.authError = error.message; return; }
      this.authPass = "";
      await this.loadCloud();
    },
    async signUp() {
      if (!sb) return;
      this.authBusy = true; this.authError = "";
      const { data, error } = await sb.auth.signUp({ email: this.authEmail.trim(), password: this.authPass });
      this.authBusy = false;
      if (error) { this.authError = error.message; return; }
      if (data && data.session) { this.authPass = ""; await this.loadCloud(); }
      else this.authError = "Account created — check your email to confirm, then sign in.";
    },
    async signOut() {
      if (sb) await sb.auth.signOut();
      this.user = null;
      this.positions = [];   // keep your data private on shared computers
      this.sync = "";
      this.cloudSkip = false;
    },

    // ---------- cloud: data ----------
    async loadCloud() {
      if (!sb || !this.user) return;
      this.busy = "Loading from cloud…";
      try {
        const { data, error } = await sb.from("positions").select("id,data");
        if (error) throw error;
        const rows = data || [];
        const indRow = rows.find((r) => r.id === INDUSTRIES_ROW_ID);
        if (indRow && indRow.data && Array.isArray(indRow.data.list)) this.industries = indRow.data.list;
        const cloudPositions = rows.filter((r) => r.id !== INDUSTRIES_ROW_ID).map((r) => ({ ...r.data, id: r.id }));
        if (cloudPositions.length === 0 && this.positions.length > 0) {
          // first sign-in with existing local data: push it up automatically
          await this.replaceCloud(this.positions);
        } else {
          this.positions = cloudPositions;
          this.persist(); // keep the Claude-storage copy in step when available
        }
        this.setSynced();
      } catch (e) { this.sync = "Sync failed"; this.saveError = true; }
      this.busy = null;
    },
    setSynced() {
      const d = new Date();
      const p = (n) => String(n).padStart(2, "0");
      this.sync = "Synced " + p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
      this.saveError = false;
    },
    async saveCloud(p) {
      if (!sb || !this.user) return;
      this.sync = "Saving…";
      try {
        const { error } = await sb.from("positions").upsert({ id: p.id, data: p, updated_at: new Date().toISOString() });
        if (error) throw error;
        this.setSynced();
      } catch (e) { this.sync = "Sync failed"; this.saveError = true; }
    },
    async deleteCloud(id) {
      if (!sb || !this.user) return;
      this.sync = "Saving…";
      try {
        const { error } = await sb.from("positions").delete().eq("id", id);
        if (error) throw error;
        this.setSynced();
      } catch (e) { this.sync = "Sync failed"; this.saveError = true; }
    },
    async replaceCloud(list) {
      if (!sb || !this.user) return;
      this.sync = "Saving…";
      try {
        const del = await sb.from("positions").delete().neq("id", INDUSTRIES_ROW_ID);
        if (del.error) throw del.error;
        if (list.length) {
          const rows = list.map((p) => ({ id: p.id, data: p, updated_at: new Date().toISOString() }));
          const ins = await sb.from("positions").upsert(rows);
          if (ins.error) throw ins.error;
        }
        this.setSynced();
      } catch (e) { this.sync = "Sync failed"; this.saveError = true; }
    },
    async saveIndustriesCloud() {
      if (!sb || !this.user) return;
      try {
        await sb.from("positions").upsert({ id: INDUSTRIES_ROW_ID, data: { list: this.industries }, updated_at: new Date().toISOString() });
      } catch (e) { /* non-critical */ }
    },

    // ---------- saving ----------
    async persist() {
      if (!this.hasStorage) return;
      try {
        await window.storage.set("positions-v1", JSON.stringify(this.positions));
        this.saveError = false;
      } catch (e) { this.saveError = true; }
    },
    async persistInd() {
      if (!this.hasStorage) return;
      try { await window.storage.set("industries-v1", JSON.stringify(this.industries)); }
      catch (e) { this.saveError = true; }
    },

    // ---------- positions ----------
    openAdd() { this.form = EMPTY(); this.form.market = this.marketTab; this.editId = null; this.showForm = true; },
    openEdit(p) {
      this.form = JSON.parse(JSON.stringify({ ...EMPTY(), ...p }));
      if (!this.form.buys.length) this.form.buys = [blankFill()];
      this.editId = p.id;
      this.showForm = true;
      if (this.form.shots && this.form.shots.length) this.loadShotUrls(this.form.shots); // load previews for saved screenshots
    },
    submitPosition() {
      const c = this.calc(this.form);
      if (!this.form.name.trim() || !c.buyUnits || !this.form.buys.some((f) => f.at)) return;
      if (c.sellUnits > c.buyUnits) return; // oversold — the warning in the dialog explains
      const clean = JSON.parse(JSON.stringify(this.form));
      // drop completely empty fill rows
      clean.buys = clean.buys.filter((f) => this.num(f.units) > 0 || f.price !== "" || f.fee !== "" || f.at !== "");
      clean.sells = clean.sells.filter((f) => this.num(f.units) > 0 || f.price !== "" || f.fee !== "" || f.at !== "");
      if (this.editId) {
        clean.id = this.editId;
        this.positions = this.positions.map((p) => (p.id === this.editId ? clean : p));
      } else {
        clean.id = Date.now().toString(36);
        this.positions = [clean, ...this.positions];
      }
      this.showForm = false;
      const at = c.firstBuyAt ? new Date(c.firstBuyAt) : null;
      if (at && !isNaN(at)) this.openMonths[at.getFullYear() + "-" + String(at.getMonth() + 1).padStart(2, "0")] = true;
      this.persist();
      this.saveCloud(clean);
    },
    askDelete(p) { this.confirmDel = p; },
    doDelete() {
      if (!this.confirmDel) return;
      const id = this.confirmDel.id;
      const shots = (this.confirmDel.shots || []).map((s) => s.path);
      this.positions = this.positions.filter((p) => p.id !== id);
      this.confirmDel = null;
      this.persist();
      this.deleteCloud(id);
      if (shots.length && sb && this.user) {
        sb.storage.from("screenshots").remove(shots).catch(() => { /* orphan files, harmless */ });
      }
    },

    // ---------- industries ----------
    addIndustry() {
      const v = this.newInd.trim();
      if (!v || this.industries.includes(v)) return;
      this.industries.push(v);
      this.newInd = "";
      this.persistInd();
      this.saveIndustriesCloud();
    },
    removeIndustry(v) {
      this.industries = this.industries.filter((i) => i !== v);
      this.persistInd();
      this.saveIndustriesCloud();
    },

    // ---------- Excel export / import ----------
    // one row per fill; position-level info and computed summary on the first row of each position
    async exportXlsx() {
      this.busy = "Exporting to Excel…";
      await new Promise((r) => setTimeout(r, 60));
      try {
        const rows = [];
        this.positions.forEach((p) => {
          const c = this.calc(p);
          const meta = (first) => first ? {
            "Industry": p.industry, "Signals": this.signalText(p),
            "Reason to buy": p.reasonBuy || "", "Reason to sell": p.reasonSell || "", "Remarks": p.remarks || "",
            "Avg cost": c.buyUnits ? c.avgCost : "", "Total buy cost": c.totalBuyCost,
            "Total sell cost": c.totalSellCost === null ? "" : c.totalSellCost,
            "P/L": c.status === "closed" ? c.pl : "", "P/L %": c.status === "closed" && c.totalBuyCost ? (c.pl / c.totalBuyCost * 100) : "",
            "Status": c.status,
            "Cut loss price": p.stop !== "" && p.stop !== undefined ? this.num(p.stop) : "",
          } : { "Industry": "", "Signals": "", "Reason to buy": "", "Reason to sell": "", "Remarks": "",
                "Avg cost": "", "Total buy cost": "", "Total sell cost": "", "P/L": "", "P/L %": "", "Status": "", "Cut loss price": "" };
          let first = true;
          (p.buys || []).forEach((f) => {
            rows.push({ "Position ID": p.id, "Market": p.market, "Stock name": p.name, "Type": "BUY",
              "Units": this.num(f.units), "Price": this.num(f.price), "Platform fee": this.num(f.fee), "Datetime": f.at || "", ...meta(first) });
            first = false;
          });
          (p.sells || []).forEach((f) => {
            rows.push({ "Position ID": p.id, "Market": p.market, "Stock name": p.name, "Type": "SELL",
              "Units": this.num(f.units), "Price": this.num(f.price), "Platform fee": this.num(f.fee), "Datetime": f.at || "", ...meta(first) });
            first = false;
          });
        });
        const ws = XLSX.utils.json_to_sheet(rows);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, "Fills");
        XLSX.writeFile(wb, "trade-log.xlsx");
      } catch (e) { this.saveError = true; }
      this.busy = null;
    },

    async importXlsx(e) {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      this.busy = "Importing from Excel…";
      await new Promise((r) => setTimeout(r, 60));
      try {
        const buf = await file.arrayBuffer();
        const wb = XLSX.read(buf);
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(ws, { defval: "" });
        let imported = [];

        if (rows.length && rows[0]["Type"] !== undefined && rows[0]["Position ID"] !== undefined) {
          // new fill-level format: group rows by Position ID
          const map = new Map();
          const sig = (s, w) => String(s).toLowerCase().includes(w);
          rows.forEach((r) => {
            const pid = String(r["Position ID"]);
            if (!pid || !String(r["Stock name"] || "").trim()) return;
            if (!map.has(pid)) {
              map.set(pid, {
                id: pid, market: r["Market"] === "US" ? "US" : "MY",
                name: String(r["Stock name"]), industry: "", buys: [], sells: [],
                reasonBuy: "", reasonSell: "", remarks: "",
                sigMacd: false, sigSar: false, sigRsi: false, sigVol: false,
              });
            }
            const p = map.get(pid);
            // position-level info lives on the first row that carries it
            if (r["Industry"]) p.industry = String(r["Industry"]);
            if (r["Reason to buy"]) p.reasonBuy = String(r["Reason to buy"]);
            if (r["Reason to sell"]) p.reasonSell = String(r["Reason to sell"]);
            if (r["Remarks"]) p.remarks = String(r["Remarks"]);
            if (r["Signals"]) { p.sigMacd = sig(r["Signals"], "macd"); p.sigSar = sig(r["Signals"], "sar"); p.sigRsi = sig(r["Signals"], "rsi"); p.sigVol = sig(r["Signals"], "volume"); }
            if (r["Cut loss price"] !== "" && r["Cut loss price"] !== undefined) p.stop = String(r["Cut loss price"]);
            const fill = { units: String(r["Units"] ?? ""), price: String(r["Price"] ?? ""), fee: String(r["Platform fee"] ?? ""), at: String(r["Datetime"] || "") };
            if (String(r["Type"]).toUpperCase() === "SELL") p.sells.push(fill); else p.buys.push(fill);
          });
          imported = [...map.values()];
        } else if (rows.length && rows[0]["Entry price"] !== undefined) {
          // old single-fill format (e.g. my-trades-import.xlsx) — each row becomes a position
          imported = rows.filter((r) => String(r["Stock name"] || "").trim()).map((r, i) => this.migrateOld({
            id: Date.now().toString(36) + "-" + i,
            market: r["Market"] === "US" ? "US" : "MY",
            name: String(r["Stock name"]), industry: String(r["Industry"] || ""),
            units: r["Units"] === "" ? "" : String(r["Units"]),
            entryPrice: r["Entry price"] === "" ? "" : String(r["Entry price"]),
            buyFee: r["Platform fee (buy)"] === "" ? "" : String(r["Platform fee (buy)"]),
            sellPrice: r["Selling price"] === "" ? null : String(r["Selling price"]),
            sellFee: r["Platform fee (sell)"] === "" ? "" : String(r["Platform fee (sell)"]),
            buyAt: String(r["Buy datetime"] || ""), sellAt: String(r["Sell datetime"] || ""),
            reasonBuy: String(r["Reason to buy"] || ""), reasonSell: String(r["Reason to sell"] || ""),
            remarks: String(r["Remarks"] || ""), sigMacd: false, sigSar: false, sigRsi: false, sigVol: false,
          }));
        }

        if (imported.length) {
          this.positions = imported; // import replaces the current log
          const fresh = [...new Set(imported.map((p) => p.industry).filter((v) => v && !this.industries.includes(v)))];
          if (fresh.length) { this.industries = this.industries.concat(fresh); this.persistInd(); this.saveIndustriesCloud(); }
          await this.persist();
          await this.replaceCloud(imported);
        }
      } catch (err) { this.saveError = true; }
      e.target.value = "";
      this.busy = null;
    },
  },
}).mount("#app");
