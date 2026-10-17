import { useCallback, useEffect, useRef, useState } from "react";
import { actualCatalogueUrl, config, isCheckoutDemo, modeCopy } from "./business";
import { deriveCategories, filterProducts, matches } from "./catalogue";
import {
  diffSummary,
  priceChanges,
  summarize,
  useCart,
  type OrderSummary,
} from "./cart";
import { blockedReason, orderingAllowed, quantity, rupees, totals } from "./pricing";
import { emptyBuyer, type Buyer, type Product, type Snapshot } from "./model";
import { validateBuyer } from "./buyer";
import { RECIPIENT_ERROR, makeRequest, type RequestDraft } from "./whatsapp";
import { useAudio } from "./audio";
import { useFireworks } from "./fireworks";
import { ImageIndexContext, loadImageIndex, type ImageIndex } from "./images";
import { useSheet } from "./sheet/useSheet";
import type { SheetState, SheetStore } from "./sheet/store";
import {
  CouponBox,
  Modal,
  OfferStrip,
  PhotoLinks,
  Price,
  ProductImage,
  Quantity,
  useStickyOffset,
} from "./components";

// A neutral descriptive heading, used only while the sheet's Shop name is blank. It is not a
// business name and is never put in the WhatsApp message.
const DEFAULT_HEADING = "Diwali crackers";
const time = (ms: number) =>
  new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit" }).format(
    ms,
  );
// An Indian number such as 919876543210 becomes "+91 98765 43210"; other lengths are shown as digits after a plus sign.
const phoneDisplay = (n: string) =>
  /^91\d{10}$/.test(n) ? `+91 ${n.slice(2, 7)} ${n.slice(7)}` : `+${n}`;
// A card shows the shot count only when the name does not already say it.
const nameStatesShots = (p: Product) =>
  p.shots !== null &&
  new RegExp(`\\b${p.shots}\\s*-?\\s*shots?\\b`, "i").test(p.name);

// Customer wording for why the data could not be loaded. Detail stays in the console.
function failureText(state: SheetState) {
  switch (state.error?.kind) {
    case "access":
      return "The price list isn’t available to the public right now. The seller needs to check its sharing settings.";
    case "structure":
      return "The price list is being updated and can’t be read yet. Please try again in a few minutes.";
    case "empty":
      return "The price list is empty right now. Please try again shortly.";
    case "timeout":
      return "The price list took too long to load.";
    default:
      return navigator.onLine
        ? "We couldn’t reach the price list. Check your connection and try again."
        : "You appear to be offline.";
  }
}

export default function App() {
  const { store, state } = useSheet();
  const [images, setImages] = useState<ImageIndex>({});
  useEffect(() => {
    const c = new AbortController();
    void loadImageIndex(c.signal).then(setImages);
    return () => c.abort();
  }, []);
  return (
    <ImageIndexContext.Provider value={images}>
      {state.snapshot ? (
        <Shop snapshot={state.snapshot} state={state} store={store} />
      ) : (
        <LoadScreen state={state} store={store} />
      )}
    </ImageIndexContext.Provider>
  );
}

// Initial loading, or no usable data at all (no cache and the fetch failed). Never shows
// placeholder products.
function LoadScreen({ state, store }: { state: SheetState; store: SheetStore }) {
  return (
    <main className="load-screen" aria-live="polite">
      {state.phase === "loading" ? (
        <>
          <div className="skeleton" aria-hidden="true" />
          <p role="status">Loading the latest prices…</p>
        </>
      ) : (
        <div className="empty" role="alert">
          <span aria-hidden="true">✧</span>
          <h1>We couldn’t load the crackers list</h1>
          <p>{failureText(state)}</p>
          <button
            className="button primary"
            onClick={() => void store.refresh({ force: true }).catch(() => {})}
          >
            Try again
          </button>
          {state.error && (
            <details className="dev-details">
              <summary>Technical details</summary>
              <pre>
                {state.error.message}
                {"\n"}
                {JSON.stringify(state.error.diagnostics, null, 2)}
              </pre>
            </details>
          )}
        </div>
      )}
    </main>
  );
}

function Shop({
  snapshot,
  state,
  store,
}: {
  snapshot: Snapshot;
  state: SheetState;
  store: SheetStore;
}) {
  const { products, offers, settings } = snapshot;
  const heading = settings.shopName ?? DEFAULT_HEADING;
  const byId = new Map(products.map((p) => [p.id, p]));
  const listed = products.filter((p) => p.visible);
  const categories = deriveCategories(products);
  const [query, setQuery] = useState(""),
    [categoryChoice, setCategory] = useState("all"),
    [sort, setSort] = useState("source");
  // A category that has disappeared (renamed, or its last product hidden) falls back to All
  // without losing the search or sort.
  const category = categories.some((c) => c.key === categoryChoice)
    ? categoryChoice
    : "all";
  const [detailId, setDetailId] = useState<string | null>(null),
    [cartOpen, setCartOpen] = useState(false),
    [stage, setStage] = useState<"cart" | "buyer">("cart");
  // The open product is looked up by ID on every render, so a refresh updates its price and stock.
  const detail = detailId ? (byId.get(detailId) ?? null) : null;
  const setDetail = (p: Product | null) => setDetailId(p?.id ?? null);
  const [detailQuantity, setDetailQuantity] = useState(1);
  const [toast, setToast] = useState(""),
    [undo, setUndo] = useState<{ p: Product; qty: number } | null>(null);
  const [buyer, setBuyer] = useState<Buyer>({ ...emptyBuyer }),
    [errors, setErrors] = useState<Partial<Record<keyof Buyer, string>>>({});
  const [draft, setDraft] = useState<RequestDraft>(),
    [handoff, setHandoff] = useState(""),
    // Local checkout demo only: the request a real handoff would have opened.
    [dryRun, setDryRun] = useState<RequestDraft | null>(null),
    [manualCopy, setManualCopy] = useState(false),
    [clearConfirm, setClearConfirm] = useState(false);
  const [busy, setBusy] = useState(false),
    [online, setOnline] = useState(navigator.onLine);
  const [preparedFingerprint, setPreparedFingerprint] = useState<string | null>(
    null,
  );
  const [downloadRequested, setDownloadRequested] = useState(false);
  // What the customer last reviewed, and what changed since (see checkout()).
  const reviewed = useRef<OrderSummary | null>(null);
  const [changes, setChanges] = useState<string[]>([]);
  const [checkoutError, setCheckoutError] = useState("");
  const requestPrepared =
    !draft?.long || preparedFingerprint === draft.fingerprint;
  const tapGuard = useRef(0);
  const checking = useRef(false);
  const announce = useCallback((s: string) => setToast(s), []);
  const { cart, coupon, setCoupon, seen, names, save, update, acknowledge, notice } =
    useCart(config, announce);
  const audio = useAudio(config.soundVolume);
  const fireworks = useFireworks();
  useStickyOffset();
  const canOrder = orderingAllowed(config);
  const mode = modeCopy(canOrder);
  const method = config.fulfilment.find(
    (f) => f.id === buyer.method && f.verified,
  );
  const amount = totals(cart, products, offers, config, method, coupon);
  // Header badge counts everything saved, including items that can't be ordered right now.
  const cartUnits = Object.values(cart).reduce((a, b) => a + b, 0);
  // Every saved item stays visible, even if the sheet no longer lists it.
  const selected = Object.keys(cart).map((id) => ({
    id,
    qty: cart[id],
    product: byId.get(id),
  }));
  // The exact request WhatsApp would open, built only once the form is valid so the shopper can
  // inspect it before continuing. Same builder and same draft as the handoff itself.
  let preview: RequestDraft | undefined;
  if (cartOpen && stage === "buyer") {
    try {
      preview = makeRequest(cart, snapshot, buyer, config, coupon, draft);
    } catch {
      preview = undefined;
    }
  }
  const fulfilmentText = !method
    ? "Not chosen yet"
    : method.type === "delivery"
      ? `Delivery to ${[buyer.address, buyer.locality, buyer.city, buyer.state, buyer.pin].filter((v) => v.trim()).join(", ") || "an address you enter above"}`
      : method.address
        ? `Pickup — ${method.address}`
        : method.label;
  const visible = filterProducts(products, query, category, sort);
  const searchProducts = listed.filter((p) => matches(p, query));
  useEffect(() => {
    setDraft(undefined);
    setHandoff("");
    setDryRun(null);
    setPreparedFingerprint(null);
  }, [cart, coupon]);
  const cartReady =
    canOrder &&
    selected.length > 0 &&
    selected.every((l) => !blockedReason(l.product, config));
  useEffect(() => {
    if (detailId) setDetailQuantity(cart[detailId] || 1);
  }, [detailId]);
  // Seen once the catalogue arrives or changes: compare the customer's saved items with the
  // newly fetched data and say what moved. Nothing is removed or re-priced silently.
  const lastVersion = useRef<string | null>(null);
  const lastSnapshot = useRef<Snapshot | null>(null);
  useEffect(() => {
    const previous = lastSnapshot.current;
    lastSnapshot.current = snapshot;
    if (lastVersion.current === snapshot.version) return;
    lastVersion.current = snapshot.version;
    if (!Object.keys(cart).length) return;
    const notes = previous
      ? diffSummary(
          reviewed.current ?? summarize(cart, previous, config, coupon, names),
          summarize(cart, snapshot, config, coupon, names),
        )
      : priceChanges(cart, seen, products);
    if (notes.length) setChanges((c) => [...new Set([...c, ...notes])]);
  }, [snapshot.version]);
  // Keep the category chip, a stale detail view and the cart consistent after a refresh.
  useEffect(() => {
    if (category !== categoryChoice) setCategory("all");
  }, [category, categoryChoice]);
  useEffect(() => {
    if (cartOpen && stage === "buyer")
      requestAnimationFrame(() =>
        document.getElementById("buyer-name")?.focus(),
      );
  }, [cartOpen, stage]);
  useEffect(() => {
    const id = window.setTimeout(() => {
      setToast("");
      setUndo(null);
    }, 6000);
    return () => window.clearTimeout(id);
  }, [toast]);
  useEffect(() => {
    const listener = () => setOnline(navigator.onLine);
    window.addEventListener("online", listener);
    window.addEventListener("offline", listener);
    return () => {
      window.removeEventListener("online", listener);
      window.removeEventListener("offline", listener);
    };
  }, []);
  const pageTitle = settings.shopName
    ? `${settings.shopName} · ${config.seo.title}`
    : config.seo.title;
  useEffect(() => {
    document.title = pageTitle;
    document
      .querySelector('meta[property="og:title"]')
      ?.setAttribute("content", pageTitle);
  }, [pageTitle]);
  useEffect(() => {
    document
      .querySelector('meta[name="description"]')
      ?.setAttribute("content", config.seo.description);
    document
      .querySelector('meta[property="og:description"]')
      ?.setAttribute("content", config.seo.description);
    const entries: [string, string | null][] = [
      ["canonical", config.seo.canonical],
      ["og:image", config.seo.ogImage],
    ];
    for (const [rel, url] of entries)
      if (url && /^https:\/\//.test(url)) {
        const node = document.createElement(
          rel === "canonical" ? "link" : "meta",
        );
        if (rel === "canonical") {
          node.setAttribute("rel", rel);
          node.setAttribute("href", url);
        } else {
          node.setAttribute("property", rel);
          node.setAttribute("content", url);
        }
        document.head.append(node);
      }
  }, []);
  function add(p: Product) {
    if (update(p, (cart[p.id] || 0) + 1)) {
      audio.tone("add");
      void fireworks.play();
      setStage("cart");
      setHandoff("");
    }
  }
  function change(p: Product, v: unknown) {
    const result = update(p, v);
    if (result) {
      setStage("cart");
      setHandoff("");
    }
    return result;
  }
  function removeLine(id: string, name: string) {
    const next = { ...cart };
    const qty = next[id];
    delete next[id];
    save(next);
    const p = byId.get(id);
    if (p) setUndo({ p, qty });
    announce(`${name} removed.`);
    setStage("cart");
    setHandoff("");
    audio.tone("remove");
  }
  function openCart() {
    setCartOpen(true);
    setStage("cart");
  }
  // The customer has seen and accepted the current data: later differences are "changes".
  function accept() {
    reviewed.current = summarize(cart, snapshot, config, coupon, names);
    setChanges([]);
    setCheckoutError("");
    acknowledge(products);
  }
  function proceed() {
    accept();
    setBuyer((b) => ({
      ...b,
      method: b.method || config.fulfilment.find((f) => f.verified)?.id || "",
    }));
    setStage("buyer");
  }
  // Continue to WhatsApp. Always fetches the sheet first; the message is built from exactly the
  // snapshot that fetch returned, and only if it matches what the customer reviewed.
  async function checkout() {
    if (checking.current) return; // double click / parallel attempt
    const next = validateBuyer(buyer, config);
    setErrors(next);
    if (Object.keys(next).length) {
      requestAnimationFrame(() =>
        document.getElementById(`buyer-${Object.keys(next)[0]}`)?.focus(),
      );
      return;
    }
    if (changes.length) return;
    if (!navigator.onLine) {
      setCheckoutError(
        "You are offline, so the current prices can’t be confirmed and your order was not prepared. Your cart and details are saved. Reconnect and try again.",
      );
      return;
    }
    checking.current = true;
    setBusy(true);
    setCheckoutError("");
    store.lock();
    try {
      let fresh: Snapshot;
      try {
        fresh = await store.refreshForCheckout();
      } catch {
        setCheckoutError(
          "We couldn’t confirm the current prices and availability, so your order was not prepared. Your cart and details are saved. Check your connection and try again.",
        );
        return;
      }
      const now = summarize(cart, fresh, config, coupon, names);
      const diffs = diffSummary(reviewed.current ?? now, now);
      const blocked = now.lines.filter((l) => l.state !== "ok");
      if (diffs.length || blocked.length) {
        setChanges(
          diffs.length
            ? diffs
            : blocked.map((l) => `${l.name} can’t be ordered right now.`),
        );
        setHandoff("");
        return;
      }
      const current = makeRequest(cart, fresh, buyer, config, coupon, draft);
      setDraft(current);
      setManualCopy(false);
      setDownloadRequested(false);
      handoffRequest(current);
    } catch (error) {
      setCheckoutError((error as Error).message);
    } finally {
      checking.current = false;
      setBusy(false);
      store.unlock();
    }
  }
  function handoffRequest(provided?: RequestDraft) {
    if (Date.now() - tapGuard.current < 1000) return;
    try {
      const current =
        provided ??
        draft ??
        makeRequest(cart, snapshot, buyer, config, coupon, draft);
      if (!navigator.onLine) {
        setHandoff(
          "You are offline. Copy or download your request, then retry when connected.",
        );
        return;
      }
      if (current.long && preparedFingerprint !== current.fingerprint) {
        setHandoff(
          "Copy the complete request first, or download it and confirm you will attach the file.",
        );
        return;
      }
      tapGuard.current = Date.now();
      if (isCheckoutDemo) {
        // Dry run: show what would have been opened. WhatsApp is never contacted.
        setDryRun(current);
        setHandoff(
          "Dry run only: WhatsApp was not opened and nothing was sent. The link and message that would have been used are shown below.",
        );
        audio.tone("handoff");
        void fireworks.play();
        return;
      }
      const opened = window.open(current.url, "_blank");
      if (opened) {
        opened.opener = null;
        void fireworks.play();
        setHandoff(
          current.long
            ? "WhatsApp opened. Paste the complete request or attach your downloaded file, then tap Send. Wait for the seller’s confirmation."
            : "WhatsApp opened. If you sent the request, wait for the seller’s confirmation.",
        );
      } else
        setHandoff(
          "WhatsApp could not open. Allow the new tab, or use the copy/download options and contact number below.",
        );
      audio.tone("handoff");
    } catch (e) {
      setHandoff((e as Error).message);
      setStage("cart");
    }
  }
  async function copy() {
    if (!draft) return;
    try {
      await navigator.clipboard.writeText(draft.message);
      setPreparedFingerprint(draft.fingerprint);
      announce("Complete request copied.");
    } catch {
      setManualCopy(true);
      announce(
        "Clipboard unavailable. Select the complete request below and copy it manually.",
      );
    }
  }
  function download() {
    if (!draft) return;
    const url = URL.createObjectURL(
      new Blob([draft.message], { type: "text/plain;charset=utf-8" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `${draft.reference}.txt`;
    link.click();
    setDownloadRequested(true);
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function field(
    key: Exclude<keyof Buyer, "acknowledged" | "method">,
    label: string,
    required = false,
    max = 200,
  ) {
    return (
      <label className="field" htmlFor={`buyer-${key}`}>
        {label}
        {required ? " *" : ""}
        <input
          id={`buyer-${key}`}
          name={key}
          value={buyer[key]}
          maxLength={max}
          required={required}
          inputMode={
            key === "mobile" ? "tel" : key === "pin" ? "numeric" : "text"
          }
          autoComplete={
            key === "name"
              ? "name"
              : key === "mobile"
                ? "tel"
                : key === "address"
                  ? "street-address"
                  : key === "pin"
                    ? "postal-code"
                    : "off"
          }
          aria-invalid={!!errors[key]}
          aria-describedby={errors[key] ? `error-${key}` : undefined}
          onChange={(e) => {
            setBuyer({ ...buyer, [key]: e.target.value });
            setDraft(undefined);
            setHandoff("");
            setPreparedFingerprint(null);
          }}
        />
        {errors[key] && (
          <span className="error" id={`error-${key}`}>
            {errors[key]}
          </span>
        )}
      </label>
    );
  }
  const footerPolicy = (key: keyof typeof config.policies, label: string) =>
    config.policies[key] ? (
      <details>
        <summary>{label}</summary>
        <p>{config.policies[key]}</p>
      </details>
    ) : null;
  return (
    <>
      <a className="skip-link" href="#catalogue">
        Skip to catalogue
      </a>
      {isCheckoutDemo && (
        <div className="demo-label" data-sticky="demo" role="note">
          Local checkout demo — test data
        </div>
      )}
      <div className="preview-banner">
        {mode.banner}
        {isCheckoutDemo && (
          <>
            {" · "}
            <a href={actualCatalogueUrl()}>Switch to the actual catalogue</a>
          </>
        )}
      </div>
      {(state.stale || state.refreshing) && state.error && (
        <div className="stale-banner" role="status">
          <span>
            We couldn’t check for the latest prices and availability, so what
            you see may be out of date
            {state.fetchedAt ? ` (last checked ${time(state.fetchedAt)})` : ""}.
          </span>
          <button
            className="text-button"
            disabled={state.refreshing}
            onClick={() => void store.refresh({ force: true }).catch(() => {})}
          >
            {state.refreshing ? "Checking…" : "Try again"}
          </button>
        </div>
      )}
      {state.stale && !state.error && (
        <div className="stale-banner" role="status">
          Showing the last saved prices while we check for updates…
        </div>
      )}
      <header data-sticky="header">
        <a className="brand" href="#">
          <svg viewBox="0 0 48 48" aria-hidden="true">
            <path d="M6 29h36Q37 43 24 43T6 29" fill="currentColor" />
            <path d="M24 4q-13 17 0 22Q34 21 24 4" fill="currentColor" />
          </svg>
          <span>
            {heading}
            <small>Light up the celebration</small>
          </span>
        </a>
        <nav aria-label="Main navigation">
          <a href="#catalogue">Shop</a>
          <a className="how-nav" href="#how-it-works">
            How it works
          </a>
          <a href="#contact">Contact</a>
        </nav>
        <div className="header-actions">
          <button
            className="sound"
            onClick={audio.toggle}
            aria-label={audio.label}
            aria-pressed={audio.isOn}
          >
            <span className="sound-icon" aria-hidden="true">
              ♪
            </span>{" "}
            <span className="sound-label">{audio.label}</span>
            {/* Short visible label on narrow screens; the accessible name contains it. On/off
                is shown by the filled button and the struck-through note, and by aria-pressed. */}
            <span className="sound-short">Sound</span>
          </button>
          {canOrder && (
            <button
              className="cart-button"
              onClick={openCart}
              aria-label={`Open cart, ${cartUnits} units`}
            >
              <span aria-hidden="true">🛒</span>{" "}
              <span className="cart-label">Cart</span>{" "}
              <span className="badge" key={cartUnits}>
                {cartUnits}
              </span>
            </button>
          )}
        </div>
      </header>
      <main>
        <section className="hero">
          <div className="hero-copy">
            <h1>Bring home the festival of lights.</h1>
            <p>{mode.hero}</p>
            <div className="hero-actions">
              <a className="button gold" href="#catalogue">
                Browse crackers
              </a>
              <a className="hero-secondary" href="#how-it-works">
                How it works
              </a>
            </div>
          </div>
          <div className="hero-art" aria-hidden="true">
            <div className="firework fw-one">
              {Array.from({ length: 16 }, (_, i) => (
                <i key={i} style={{ transform: `rotate(${i * 22.5}deg)` }} />
              ))}
            </div>
            <svg className="diya" viewBox="0 0 400 220">
              <defs>
                <radialGradient id="glow">
                  <stop stopColor="#ffd77a" stopOpacity=".22" />
                  <stop offset="1" stopColor="#ffd77a" stopOpacity="0" />
                </radialGradient>
                <linearGradient id="bowl" x2="0" y2="1">
                  <stop stopColor="#f2c170" />
                  <stop offset="1" stopColor="#b36b29" />
                </linearGradient>
              </defs>
              <circle cx="200" cy="80" r="110" fill="url(#glow)" />
              <path
                d="M200 19C170 65 166 98 200 104C230 91 219 56 200 19"
                fill="#ffd58c"
              />
              <path
                d="M200 52C187 76 188 92 200 99C212 88 209 70 200 52"
                fill="#fff3ca"
              />
              <ellipse cx="200" cy="132" rx="112" ry="22" fill="#704124" />
              <path
                d="M88 130C104 211 290 211 312 130Q200 163 88 130"
                fill="url(#bowl)"
              />
              <path
                d="M101 151Q200 178 299 151M120 173Q200 192 280 173"
                stroke="#fff0bd"
                fill="none"
                strokeOpacity=".5"
              />
              <ellipse cx="200" cy="133" rx="104" ry="17" fill="#c88c3e" />
              <path d="M200 102v29" stroke="#382233" strokeWidth="4" />
            </svg>
            <span className="art-star star-a">✧</span>
            <span className="art-star star-b">✦</span>
          </div>
        </section>
        <section
          className="catalogue"
          id="catalogue"
          aria-labelledby="catalogue-title"
        >
          <OfferStrip offers={offers} />
          {state.fetchedAt && (
            <p className="fetched-line">
              Prices fetched at {time(state.fetchedAt)}.{" "}
              <button
                className="text-button"
                disabled={state.refreshing}
                onClick={() =>
                  void store.refresh({ force: true }).catch(() => {})
                }
              >
                {state.refreshing ? "Refreshing…" : "Refresh"}
              </button>
            </p>
          )}
          <div className="shop-bar" data-sticky="bar">
            <div className="search-row">
              <label className="search">
                <span aria-hidden="true">⌕</span>
                <input
                  aria-label="Search crackers"
                  type="search"
                  placeholder="Search products or categories…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
                {query && (
                  <button
                    type="button"
                    className="clear-search"
                    aria-label="Clear search"
                    onClick={() => setQuery("")}
                  >
                    ✕
                  </button>
                )}
              </label>
            </div>
            <div
              className="categories"
              role="group"
              aria-label="Product categories. Counts follow your search."
              title="Counts follow your search"
            >
              {[{ key: "all", label: "All products" }, ...categories].map((c) => {
                const count =
                  c.key === "all"
                    ? searchProducts.length
                    : searchProducts.filter((p) => p.categoryKey === c.key)
                        .length;
                return (
                  <button
                    key={c.key}
                    aria-pressed={category === c.key}
                    className={
                      (category === c.key ? "active" : "") +
                      (count === 0 ? " none" : "")
                    }
                    onClick={() => setCategory(c.key)}
                    // The browser leaves a half-visible chip half hidden; reveal it fully.
                    onFocus={(e) =>
                      e.currentTarget.scrollIntoView({
                        block: "nearest",
                        inline: "nearest",
                      })
                    }
                  >
                    {c.label} <span>{count}</span>
                  </button>
                );
              })}
            </div>
          </div>
          <div className="results-bar">
            <div className="results-title">
              <h2 id="catalogue-title">Crackers</h2>
              <p aria-live="polite">
                <span className="lead-word">Showing </span>
                <strong>{visible.length}</strong> of {listed.length} products
                {category !== "all"
                  ? ` · ${categories.find((c) => c.key === category)?.label}`
                  : ""}
                {query ? ` · “${query}”` : ""}
              </p>
              {(query || category !== "all" || sort !== "source") && (
                <button
                  className="text-button"
                  onClick={() => {
                    setQuery("");
                    setCategory("all");
                    setSort("source");
                  }}
                >
                  Clear filters
                </button>
              )}
            </div>
            <label className="sort">
              <span>Sort by</span>
              <select
                aria-label="Sort products"
                value={sort}
                onChange={(e) => setSort(e.target.value)}
              >
                <option value="source">Catalogue order</option>
                <option value="low">Price: low to high</option>
                <option value="high">Price: high to low</option>
                <option value="name">Name</option>
              </select>
            </label>
          </div>
          {!listed.length ? (
            <div className="empty">
              <span aria-hidden="true">✧</span>
              <h3>No crackers are listed right now</h3>
              <p>The seller’s list is empty at the moment. Please check back soon.</p>
              <button
                disabled={state.refreshing}
                onClick={() =>
                  void store.refresh({ force: true }).catch(() => {})
                }
              >
                Check again
              </button>
            </div>
          ) : !visible.length ? (
            <div className="empty">
              <span aria-hidden="true">✧</span>
              <h3>No crackers match these filters</h3>
              <p>Try a product name or another category.</p>
              <button
                onClick={() => {
                  setQuery("");
                  setCategory("all");
                }}
              >
                Clear filters
              </button>
            </div>
          ) : (
            <div className="product-grid">
              {visible.map((p) => {
                const reason = blockedReason(p, config);
                const stock = p.inStock ? null : "Out of stock";
                return (
                  <article className="product-card" key={p.id}>
                    <button
                      className="image-button"
                      tabIndex={-1}
                      onClick={() => setDetail(p)}
                      aria-label={`View ${p.name}${p.category ? `, ${p.category}` : ""} details`}
                    >
                      <ProductImage product={p} />
                    </button>
                    <div className="product-info">
                      {p.category && <p className="category-label">{p.category}</p>}
                      <h3>{p.name}</h3>
                      <div className="price-row">
                        <Price product={p} />
                      </div>
                      {(p.piecesPerPack || (p.shots && !nameStatesShots(p))) && (
                        <ul className="facts" aria-label="Pack details">
                          {p.piecesPerPack && (
                            <li>{p.piecesPerPack} pieces per pack</li>
                          )}
                          {p.shots && !nameStatesShots(p) && (
                            <li>{p.shots} shots</li>
                          )}
                        </ul>
                      )}
                      {stock && <p className="blocked">{stock}</p>}
                      {!stock && reason && reason !== "Ordering is currently disabled" && (
                        <p className="blocked">{reason}</p>
                      )}
                      <PhotoLinks product={p} />
                      <div className="card-actions">
                        {!reason &&
                          (cart[p.id] ? (
                            <Quantity
                              value={cart[p.id]}
                              max={config.maxQuantity}
                              name={`${p.name} ${p.id}`}
                              onChange={(v) => change(p, v)}
                              onRemove={() => removeLine(p.id, p.name)}
                            />
                          ) : (
                            <button
                              className="add-button"
                              onClick={() => add(p)}
                            >
                              Add to cart <span aria-hidden="true">+</span>
                            </button>
                          ))}
                        <button
                          className="details-button"
                          onClick={() => setDetail(p)}
                          aria-label={`Details for ${p.name}${p.category ? `, ${p.category}` : ""}`}
                        >
                          Details
                        </button>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>
        <section id="how-it-works" className="how">
          <div>
            <h2>{mode.howTitle}</h2>
            <p>{mode.howIntro}</p>
          </div>
          <ol>
            {mode.steps.map(([title, text]) => (
              <li key={title}>
                <strong>{title}</strong>
                <span>{text}</span>
              </li>
            ))}
          </ol>
        </section>
      </main>
      <footer id="contact">
        <div className="footer-brand">
          <h2>{heading}</h2>
          <p>A catalogue for the festival of lights.</p>
        </div>
        <div>
          <h3>Contact the seller</h3>
          {settings.whatsapp ? (
            <a
              className="contact-number"
              href={`tel:+${settings.whatsapp}`}
              aria-label={`Call ${phoneDisplay(settings.whatsapp)}`}
            >
              <span aria-hidden="true">📞</span>
              {phoneDisplay(settings.whatsapp)}
            </a>
          ) : (
            <p>Contact details are being updated.</p>
          )}
          {config.address && <p>{config.address}</p>}
          {config.hours && <p>{config.hours}</p>}
          {canOrder && !isCheckoutDemo && settings.whatsapp && (
            <a
              className="contact-whatsapp"
              href={`https://wa.me/${settings.whatsapp}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              Chat on WhatsApp
            </a>
          )}
        </div>
        <div>
          <h3>Before you choose</h3>
          <p>
            {config.policies.fulfilment ||
              "Pickup, delivery and service areas are not yet verified."}
          </p>
          <p>No online payment is collected.</p>
          {footerPolicy("privacy", "Privacy information")}
          {footerPolicy("cancellation", "Cancellation and returns")}
          {footerPolicy("safety", "Safety and legal information")}
          <details>
            <summary>Privacy</summary>
            <p>
              Your cart (product IDs and quantities) and sound preference are
              saved on this device only. The name, mobile number, address and
              notes you enter stay in your browser and are not stored by this
              website. When you continue, they go into a WhatsApp message to the
              seller. Nothing is shared until you press Send in WhatsApp; after
              that, WhatsApp and the seller handle the message. No analytics or
              ad trackers are installed.
            </p>
          </details>
        </div>
        <div className="footer-bottom">
          <p>
            Prices and availability come from the seller’s current price list;
            the seller confirms every detail.
          </p>
          <span>Made for a thoughtful celebration ✧</span>
        </div>
      </footer>
      {canOrder && cartUnits > 0 && !cartOpen && !detail && (
        <>
          <div
            className="mobile-cart-bar"
            role="region"
            aria-label="Cart summary"
          >
            <div>
              <strong>
                {cartUnits} {cartUnits === 1 ? "unit" : "units"} selected
              </strong>
              <span>Product subtotal {rupees(amount.subtotal)}</span>
              {amount.discount > 0 && (
                <span className="offer-saving">
                  After offer {rupees(amount.afterDiscount)}
                </span>
              )}
            </div>
            <button
              className="button primary"
              aria-label={`Review cart, ${cartUnits} units`}
              onClick={openCart}
            >
              View cart
            </button>
          </div>
          <div className="mobile-cart-space" aria-hidden="true" />
        </>
      )}
      {!online && (
        <div className="offline" role="status">
          You are offline. Browsing works; WhatsApp requires a connection.
        </div>
      )}
      {fireworks.node}
      {audio.status && (
        <p role="status" className="sound-status">
          {audio.status}
        </p>
      )}
      {!cartOpen && (
        <div
          role="status"
          aria-live="polite"
          className={toast ? "toast visible" : "toast"}
        >
          {toast}
        </div>
      )}
      {detail && (
        <Modal
          title={detail.name}
          onClose={() => setDetail(null)}
          describedBy="detail-summary"
        >
          <ProductImage product={detail} large />
          <div className="detail-content">
            {detail.category && (
              <p className="category-label">{detail.category}</p>
            )}
            <div id="detail-summary">
              <p className="detail-price">
                <Price product={detail} />
              </p>
              {!detail.inStock && <p className="blocked">Out of stock</p>}
            </div>
            {detail.description && (
              <p className="description">{detail.description}</p>
            )}
            <dl>
              {detail.category && (
                <>
                  <dt>Category</dt>
                  <dd>{detail.category}</dd>
                </>
              )}
              {detail.piecesPerPack && (
                <>
                  <dt>Pieces per pack</dt>
                  <dd>{detail.piecesPerPack}</dd>
                </>
              )}
              {detail.shots && (
                <>
                  <dt>Shots</dt>
                  <dd>{detail.shots}</dd>
                </>
              )}
              <dt>Product ID</dt>
              <dd>{detail.id}</dd>
            </dl>
            <PhotoLinks product={detail} />
            {config.policies.safety && <p>{config.policies.safety}</p>}
            {!blockedReason(detail, config) && (
              <div className="detail-actions">
                <Quantity
                  value={detailQuantity}
                  max={config.maxQuantity}
                  name={detail.name}
                  onChange={(v) => {
                    const n = quantity(v, config.maxQuantity);
                    if (n === null) {
                      announce("Enter a valid whole quantity.");
                      return false;
                    }
                    setDetailQuantity(n);
                    return true;
                  }}
                />
                <button
                  className="button primary"
                  onClick={() => {
                    if (update(detail, detailQuantity)) {
                      audio.tone("add");
                      void fireworks.play();
                      setDetail(null);
                      setStage("cart");
                      setHandoff("");
                    }
                  }}
                >
                  {cart[detail.id] ? "Update cart" : "Add to cart"}
                </button>
              </div>
            )}
          </div>
        </Modal>
      )}
      {cartOpen && (
        <Modal
          drawer
          title={stage === "buyer" ? "Checkout" : "Your selection"}
          onClose={() => setCartOpen(false)}
        >
          {toast && (
            <div className="cart-toast" role="status" aria-live="polite">
              {toast}
              {undo && (
                <button
                  onClick={() => {
                    if (!blockedReason(undo.p, config)) {
                      save({ ...cart, [undo.p.id]: undo.qty });
                      announce(`${undo.p.name} restored.`);
                      setUndo(null);
                    }
                  }}
                >
                  Undo removal
                </button>
              )}
            </div>
          )}
          {notice && <p className="callout">{notice}</p>}
          {changes.length > 0 && (
            <div className="callout changes" role="alert">
              <strong>Your order changed since you last looked.</strong>
              <ul>
                {changes.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
              <button className="button secondary" onClick={accept}>
                OK, review my updated order
              </button>
            </div>
          )}
          {checkoutError && (
            <div className="callout error-callout" role="alert">
              <p>{checkoutError}</p>
              {checkoutError !== RECIPIENT_ERROR && (
                <button
                  className="button secondary"
                  disabled={busy}
                  onClick={() => void checkout()}
                >
                  Try again
                </button>
              )}
            </div>
          )}
          {stage === "cart" && (
            <div className="cart-content">
              {!selected.length ? (
                <div className="empty">
                  <h3>Your cart is empty</h3>
                  <p>Find something to brighten your celebration.</p>
                </div>
              ) : (
                <>
                  <p className="muted">
                    {cartUnits} total units · quantities do not reserve stock
                  </p>
                  {selected.map(({ id, qty, product: p }) => {
                    const reason = blockedReason(p, config);
                    return (
                      <div className="cart-line" key={id}>
                        <div>
                          <h3>{p?.name ?? names[id] ?? id}</h3>
                          {p?.category && <p>{p.category}</p>}
                          {p && (
                            <small>
                              {[
                                p.piecesPerPack
                                  ? `${p.piecesPerPack} pieces per pack`
                                  : "",
                                p.shots && !nameStatesShots(p)
                                  ? `${p.shots} shots`
                                  : "",
                                `ID ${p.id}`,
                              ]
                                .filter(Boolean)
                                .join(" · ")}
                            </small>
                          )}
                          {p && p.pricePaise !== null && (
                            <p>
                              {rupees(p.pricePaise)} each ·{" "}
                              <strong>{rupees(p.pricePaise * qty)}</strong>
                            </p>
                          )}
                          {reason && <p className="error">{reason}</p>}
                        </div>
                        {p && !reason ? (
                          <Quantity
                            name={`${p.name} ${p.id}`}
                            value={qty}
                            max={config.maxQuantity}
                            onChange={(v) => change(p, v)}
                          />
                        ) : (
                          <span className="muted">Qty {qty}</span>
                        )}
                        <button
                          className="text-button remove"
                          onClick={() => removeLine(id, p?.name ?? names[id] ?? id)}
                          aria-label={`Remove ${p?.name ?? names[id] ?? id}, ${id}`}
                        >
                          Remove
                        </button>
                      </div>
                    );
                  })}
                  <CouponBox
                    offers={offers}
                    subtotal={amount.subtotal}
                    applied={coupon}
                    result={amount.offer}
                    onApply={setCoupon}
                  />
                  <PriceSummary amount={amount} />
                  <button
                    className="button primary full"
                    disabled={!cartReady || changes.length > 0}
                    onClick={proceed}
                  >
                    Proceed to buyer details
                  </button>
                  {!cartReady && (
                    <p className="muted">
                      Remove the items marked unavailable to continue.
                    </p>
                  )}
                  <button
                    className="text-button"
                    onClick={() => setClearConfirm(true)}
                  >
                    Clear cart
                  </button>
                </>
              )}
              <button
                className="button secondary full"
                onClick={() => setCartOpen(false)}
              >
                Continue shopping
              </button>
            </div>
          )}
          {stage === "buyer" && (
            <form
              className="buyer-form"
              noValidate
              onSubmit={(e) => {
                e.preventDefault();
                void checkout();
              }}
            >
              <p>
                Enter your name and mobile number, then review your request
                below.
              </p>
              {field("name", "Full name", true, 100)}
              {field("mobile", "Mobile number", true, 30)}
              {config.fulfilment.filter((f) => f.verified).length > 1 && (
                <label className="field" htmlFor="buyer-method">
                  Fulfilment method *
                  <select
                    id="buyer-method"
                    value={buyer.method}
                    onChange={(e) =>
                      setBuyer({ ...buyer, method: e.target.value })
                    }
                    aria-invalid={!!errors.method}
                  >
                    <option value="">Choose an option</option>
                    {config.fulfilment
                      .filter((f) => f.verified)
                      .map((f) => (
                        <option key={f.id} value={f.id}>
                          {f.label}
                        </option>
                      ))}
                  </select>
                  {errors.method && (
                    <span className="error">{errors.method}</span>
                  )}
                </label>
              )}
              {method?.type === "pickup" && (
                <p className="callout">
                  {method.address || config.address
                    ? `Pickup location: ${method.address || config.address}`
                    : method.label}
                </p>
              )}
              {method?.type === "delivery" && (
                <>
                  {field("address", "Address line", true)}
                  {field("locality", "Locality / area", true)}
                  {field("city", "City", true)}
                  {field("state", "State", true)}
                  {field("pin", "PIN code", true, 6)}
                  <p className="muted">
                    A valid PIN does not guarantee serviceability. It must match
                    the configured service area.
                  </p>
                  {field("landmark", "Landmark", false)}
                </>
              )}
              {field("notes", "Order notes", false, 500)}
              <label className="ack">
                <input
                  id="buyer-acknowledged"
                  type="checkbox"
                  checked={buyer.acknowledged}
                  onChange={(e) =>
                    setBuyer({ ...buyer, acknowledged: e.target.checked })
                  }
                />
                I understand that my buyer details and request will be shared
                with the seller on WhatsApp.
              </label>
              {errors.acknowledged && (
                <p className="error">{errors.acknowledged}</p>
              )}
              <section className="review-summary" aria-labelledby="review-title">
                <h3 id="review-title">Review your request</h3>
                <ul className="review-lines">
                  {selected.map(({ id, qty, product: p }) => (
                    <li key={id}>
                      <div className="review-item">
                        <strong>{p?.name ?? names[id] ?? id}</strong>
                        {p?.category && <span>{p.category}</span>}
                        <small>
                          {[
                            `ID ${id}`,
                            p?.piecesPerPack
                              ? `${p.piecesPerPack} pieces per pack`
                              : "",
                            p?.shots ? `${p.shots} shots` : "",
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </small>
                      </div>
                      <div className="review-amount">
                        {p?.pricePaise != null ? (
                          <>
                            <span>
                              {qty} × {rupees(p.pricePaise)}
                            </span>
                            <strong>{rupees(p.pricePaise * qty)}</strong>
                          </>
                        ) : (
                          <span>Qty {qty}</span>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
                <PriceSummary amount={amount} />
                <dl className="review-buyer">
                  <dt>Name</dt>
                  <dd>{buyer.name.trim() || "Not entered yet"}</dd>
                  <dt>Mobile</dt>
                  <dd>{buyer.mobile.trim() || "Not entered yet"}</dd>
                  <dt>Fulfilment</dt>
                  <dd>{fulfilmentText}</dd>
                  {buyer.notes.trim() && (
                    <>
                      <dt>Notes</dt>
                      <dd>{buyer.notes.trim()}</dd>
                    </>
                  )}
                </dl>
                <div className="review-actions">
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => setStage("cart")}
                  >
                    Edit items
                  </button>
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => document.getElementById("buyer-name")?.focus()}
                  >
                    Edit details
                  </button>
                </div>
                <details className="complete-message">
                  <summary>View the complete WhatsApp message</summary>
                  {preview ? (
                    <pre tabIndex={0} aria-label="Complete WhatsApp message">
                      {preview.message}
                    </pre>
                  ) : (
                    <p className="muted">
                      Enter your name and mobile number and tick the
                      acknowledgement above to see the complete message.
                    </p>
                  )}
                </details>
              </section>
              {draft?.long && (
                <section
                  className="handoff-preparation"
                  aria-label="Complete order transfer"
                >
                  <h3>Copy your full order first</h3>
                  <p>
                    Your order is too long for a chat link. Copy it, then open
                    WhatsApp, paste and tap Send. Or download it and attach the
                    file.
                  </p>
                  <div className="copy-actions">
                    <button
                      type="button"
                      className="primary"
                      onClick={() => void copy()}
                    >
                      Copy Complete Order
                    </button>
                    <button type="button" onClick={download}>
                      Download Order
                    </button>
                  </div>
                  {manualCopy && (
                    <label className="field">
                      Select and copy the complete order
                      <textarea
                        readOnly
                        rows={6}
                        value={draft.message}
                        onFocus={(event) => event.target.select()}
                      />
                    </label>
                  )}
                  {(manualCopy || downloadRequested) && (
                    <label className="ack">
                      <input
                        type="checkbox"
                        checked={requestPrepared}
                        onChange={(event) =>
                          setPreparedFingerprint(
                            event.target.checked ? draft.fingerprint : null,
                          )
                        }
                      />
                      I have copied the full order, or will attach the
                      downloaded file.
                    </label>
                  )}
                  {requestPrepared && (
                    <p className="prepared-status" role="status">
                      Full order ready to paste or attach.
                    </p>
                  )}
                </section>
              )}
              {isCheckoutDemo && (
                <p className="callout">
                  <strong>Dry run.</strong> Continue to WhatsApp shows the link
                  and message here instead. It does not open WhatsApp or send
                  anything.
                </p>
              )}
              <button
                className="button whatsapp full"
                type="submit"
                disabled={
                  busy ||
                  changes.length > 0 ||
                  (!!draft?.long && !requestPrepared)
                }
              >
                {busy
                  ? "Checking the latest prices…"
                  : handoff && !draft?.long
                  ? isCheckoutDemo
                    ? "Run the dry run again"
                    : "Open WhatsApp again"
                  : "Continue to WhatsApp"}
              </button>
              <p className="muted">
                WhatsApp will open with your request. Review it and tap Send.
                Your order is confirmed only after the seller replies.
              </p>
              {handoff && (
                <p className="callout" role="status">
                  {handoff}
                </p>
              )}
              {isCheckoutDemo && dryRun && <DryRunPanel draft={dryRun} />}
              {draft && !draft.long && (
                <details className="order-backup">
                  <summary>Copy or save this order</summary>
                  <div className="copy-actions">
                    <button type="button" onClick={() => void copy()}>
                      Copy Complete Order
                    </button>
                    <button type="button" onClick={download}>
                      Download Order
                    </button>
                  </div>
                  {manualCopy && (
                    <label className="field">
                      Select and copy the complete order
                      <textarea
                        readOnly
                        rows={6}
                        value={draft.message}
                        onFocus={(event) => event.target.select()}
                      />
                    </label>
                  )}
                </details>
              )}
              <p className="muted">
                Availability and collection/delivery are confirmed by the
                seller. Your cart stays saved.
              </p>
              <button
                type="button"
                className="button secondary full"
                onClick={() => setStage("cart")}
              >
                Edit cart
              </button>
              <button
                type="button"
                className="text-button"
                onClick={() => {
                  setBuyer({ ...emptyBuyer });
                  setErrors({});
                }}
              >
                Reset buyer details
              </button>
            </form>
          )}
          {clearConfirm && (
            <div
              className="confirm-box"
              role="group"
              aria-label="Confirm clearing cart"
            >
              <p>
                Remove all selected items? This also resets the reviewed
                request.
              </p>
              <button
                onClick={() => {
                  save({});
                  setStage("cart");
                  setDraft(undefined);
                  setHandoff("");
                  setClearConfirm(false);
                  setUndo(null);
                  announce("Cart cleared.");
                }}
              >
                Yes, clear cart
              </button>
              <button onClick={() => setClearConfirm(false)}>Keep items</button>
            </div>
          )}
        </Modal>
      )}
    </>
  );
}
// Local checkout demo only (see isCheckoutDemo): what "Continue to WhatsApp" would have opened.
function DryRunPanel({ draft }: { draft: RequestDraft }) {
  const url = new URL(draft.url);
  return (
    <section className="dry-run" aria-labelledby="dry-run-title">
      <h3 id="dry-run-title">Dry run result: nothing was sent</h3>
      <p>
        On the live site this step would open WhatsApp with the link below.
        The buyer would still have to tap Send, and the seller confirms the
        order. Here, WhatsApp was not opened.
      </p>
      <dl>
        <dt>Would open</dt>
        <dd>
          <code>{draft.url}</code>
        </dd>
        <dt>Recipient</dt>
        <dd>
          +{url.pathname.slice(1)} (the real seller number; this demo never
          contacts it)
        </dd>
        <dt>Reference</dt>
        <dd>{draft.reference}</dd>
        <dt>Link length</dt>
        <dd>
          {draft.url.length} characters (limit {config.urlThreshold})
          {draft.long
            ? ". Too long for a chat link, so WhatsApp would open with a short note and the buyer pastes or attaches the complete request."
            : ". Fits in the link."}
        </dd>
      </dl>
      <h4>Message carried in the link</h4>
      <pre tabIndex={0} aria-label="Message carried in the WhatsApp link">
        {url.searchParams.get("text")}
      </pre>
      {draft.long && (
        <>
          <h4>Complete request (to paste or attach)</h4>
          <pre tabIndex={0} aria-label="Complete request">
            {draft.message}
          </pre>
        </>
      )}
    </section>
  );
}
function PriceSummary({ amount }: { amount: ReturnType<typeof totals> }) {
  return (
    <div className="price-summary">
      <p>
        <span>Product subtotal</span>
        <strong>{rupees(amount.subtotal)}</strong>
      </p>
      {amount.discount > 0 && (
        <p className="offer-saving">
          <span>
            {amount.offerName}
            {amount.couponCode ? ` (${amount.couponCode})` : ""}
          </span>
          <strong>−{rupees(amount.discount)}</strong>
        </p>
      )}
      {amount.delivery !== null && (
        <p>
          <span>Delivery / fulfilment charge</span>
          <span>{rupees(amount.delivery)}</span>
        </p>
      )}
      {amount.tax !== null && (
        <p>
          <span>Configured tax</span>
          <span>{rupees(amount.tax)}</span>
        </p>
      )}
      <p className="summary-total">
        <span>{amount.label}</span>
        <strong>{amount.text}</strong>
      </p>
      <small>
        Final payable amount and availability require seller confirmation.
      </small>
    </div>
  );
}
