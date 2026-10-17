import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Offer, Product } from "./model";
import { resolveImages, useImageIndex } from "./images";
import { bestOffer, describeOffer, type OfferResult } from "./sheet/offers";
import { isCheckoutDemo } from "./business";
import { rupees } from "./pricing";

// Selling price, plus the sheet's MRP struck through when it is a number above the selling
// price. The MRP is a comparison price only; it is never treated as a discount or coupon.
export function Price({ product: p }: { product: Product }) {
  if (p.pricePaise === null) return <strong>Price unavailable</strong>;
  const mrp = p.mrpPaise;
  return (
    <span className="price">
      <strong>{rupees(p.pricePaise)}</strong>
      {mrp != null && mrp > p.pricePaise && (
        <del className="mrp">
          <span className="sr-only">MRP </span>
          {rupees(mrp)}
        </del>
      )}
    </span>
  );
}

// Publishes the height of the sticky UI that is actually on screen as --sticky-h (and the
// header's own height as --header-h), so anchors and focused controls clear it however the
// chips wrap or the text is zoomed. When the stack would take more than 30% of the screen
// (20% on phone-width layouts), e.g. at 200% zoom or on a landscape phone, stickiness is
// switched off for the whole page.
// Elements are marked data-sticky="header" | "bar"; the header only sticks on wide screens.
export function useStickyOffset() {
  useEffect(() => {
    const root = document.documentElement;
    const wide = window.matchMedia("(min-width: 761px)");
    const update = () => {
      const header = document.querySelector<HTMLElement>(
        '[data-sticky="header"]',
      );
      const bar = document.querySelector<HTMLElement>('[data-sticky="bar"]');
      // The local demo's label (data-sticky="demo") is always pinned and not counted toward
      // the limit below; the other pinned UI sits beneath it.
      const demoHeight =
        document.querySelector<HTMLElement>('[data-sticky="demo"]')
          ?.offsetHeight ?? 0;
      root.style.setProperty("--demo-h", `${demoHeight}px`);
      const headerHeight = wide.matches ? (header?.offsetHeight ?? 0) : 0;
      const height = headerHeight + (bar?.offsetHeight ?? 0);
      // Phone-width layouts tolerate less pinned UI than wide ones.
      const off = height > window.innerHeight * (wide.matches ? 0.3 : 0.2);
      root.toggleAttribute("data-sticky-off", off);
      root.style.setProperty(
        "--sticky-h",
        `${demoHeight + (off ? 0 : height)}px`,
      );
      root.style.setProperty(
        "--header-h",
        off ? "0px" : `${headerHeight}px`,
      );
    };
    const observer = new ResizeObserver(update);
    document
      .querySelectorAll("[data-sticky]")
      .forEach((el) => observer.observe(el));
    window.addEventListener("resize", update);
    window.visualViewport?.addEventListener("resize", update);
    wide.addEventListener("change", update);
    update();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("resize", update);
      wide.removeEventListener("change", update);
    };
  }, []);
}

// The enabled offers in plain words: a one-line summary that opens to the terms.
export function OfferStrip({ offers }: { offers: Offer[] }) {
  const active = offers.filter((o) => o.enabled);
  if (!active.length) return null;
  return (
    <details className="offers">
      <summary>
        <span>
          {active.length === 1 ? "1 offer available" : `${active.length} offers available`}
        </span>
        <span className="offers-toggle">View offers</span>
      </summary>
      <ul>
        {active.map((o) => (
          <li key={o.row}>
            {o.code && <span className="code">{o.code}</span>}
            {o.name}: {describeOffer(o)}
            {o.mode === "automatic" ? " · applied automatically" : " · enter the code in your cart"}
          </li>
        ))}
      </ul>
      <p>
        Only the single best offer applies to your product total, before any
        fulfilment charge. Offers are not combined.
      </p>
    </details>
  );
}

// The cart's coupon box. A code is only applied when the customer taps Apply (or Enter) and it
// checks out against the current order; a code that does not is explained in a visible box and
// never saved. Once applied, the box shows the result with Remove, so another can be tried.
// `applied` is the saved code (empty when none); `result` is what the offer engine makes of it now.
export function CouponBox({
  offers,
  subtotal,
  applied,
  result,
  onApply,
}: {
  offers: Offer[];
  subtotal: number;
  applied: string;
  result: OfferResult;
  onApply: (code: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const [failure, setFailure] = useState<string | null>(null);
  const coupons = offers.filter((o) => o.enabled && o.mode === "coupon" && o.code);
  function apply(raw: string) {
    const code = raw.trim();
    if (!code) return setFailure("Enter a coupon code, or pick one from “View coupon codes”.");
    const check = bestOffer(subtotal, offers, code);
    if (check.status === "applied" || check.status === "beaten-by-automatic") {
      onApply(code);
      setDraft("");
      return setFailure(null);
    }
    const coupon = offers.find((o) => o.mode === "coupon" && o.enabled && o.code!.toUpperCase() === code.toUpperCase());
    const short =
      coupon?.minPaise != null && subtotal < coupon.minPaise
        ? ` Add ${rupees(coupon.minPaise - subtotal)} more to use it.`
        : "";
    setFailure(
      check.status === "unknown"
        ? `${check.message} Check the spelling, or pick one from “View coupon codes”.`
        : `${check.message}${short}`,
    );
  }
  const good = result.status === "applied";
  return (
    <div className="coupon-box">
      {applied ? (
        <div className={good ? "coupon-applied" : "coupon-applied warn"} role="status">
          <div>
            <p className="coupon-title">
              <span aria-hidden="true">{good ? "✓" : "!"}</span>{" "}
              {result.offer?.code ?? applied.trim().toUpperCase()}{good ? " applied" : ""}
            </p>
            <p>
              {good
                ? `${result.offer!.name}: you save ${rupees(result.discountPaise)}.`
                : (result.message ?? "This coupon is not giving a saving right now.")}
            </p>
          </div>
          <button type="button" className="button secondary" onClick={() => onApply("")}>
            Remove coupon
          </button>
        </div>
      ) : (
        <form
          className="coupon-form"
          onSubmit={(e) => {
            e.preventDefault();
            apply(draft);
          }}
        >
          <div className="field coupon-field">
            <label htmlFor="coupon-input">Coupon code</label>
            <div className="coupon-row">
              <input
                id="coupon-input"
                value={draft}
                maxLength={40}
                autoComplete="off"
                autoCapitalize="characters"
                aria-invalid={failure ? true : undefined}
                aria-describedby={failure ? "coupon-error" : undefined}
                onChange={(e) => {
                  setDraft(e.target.value);
                  setFailure(null);
                }}
              />
              <button type="submit" className="button primary">
                Apply
              </button>
            </div>
          </div>
        </form>
      )}
      {failure && (
        <div id="coupon-error" className="coupon-error" role="alert">
          <span className="coupon-error-icon" aria-hidden="true">
            !
          </span>
          <div>
            <strong>Coupon not applied</strong>
            <p>{failure}</p>
          </div>
        </div>
      )}
      {coupons.length > 0 && (
        <details className="coupons">
          <summary>View coupon codes</summary>
          <ul>
            {coupons.map((o) => {
              const current = good && result.offer?.row === o.row;
              return (
                <li key={o.row}>
                  <span className="code">{o.code}</span>
                  <span>{describeOffer(o)}</span>
                  {current ? (
                    <span className="coupon-current">Applied</span>
                  ) : (
                    <button
                      type="button"
                      className="text-button"
                      aria-label={`Apply code ${o.code}`}
                      onClick={() => {
                        setDraft(o.code!); // the box shows what was tried, next to any message about it
                        apply(o.code!);
                      }}
                    >
                      Apply
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </details>
      )}
    </div>
  );
}

export function Modal({
  title,
  onClose,
  children,
  drawer = false,
  describedBy,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  drawer?: boolean;
  describedBy?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    ref.current?.showModal();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      ref.current?.close();
      document.body.style.overflow = overflow;
      previous?.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={drawer ? "modal drawer" : "modal"}
      aria-labelledby="dialog-title"
      aria-describedby={describedBy}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <div className={isCheckoutDemo ? "modal-head with-demo-tag" : "modal-head"}>
        {isCheckoutDemo && (
          <p className="demo-tag">Local checkout demo — test data</p>
        )}
        <h2 id="dialog-title">{title}</h2>
        <button onClick={onClose} aria-label="Close dialog">
          ✕
        </button>
      </div>
      {children}
    </dialog>
  );
}
export function ProductImage({
  product,
  large = false,
}: {
  product: Product;
  large?: boolean;
}) {
  const index = useImageIndex();
  const { sources } = resolveImages(product, index);
  const [current, setCurrent] = useState(0),
    [failed, setFailed] = useState<Record<string, boolean>>({});
  const usable = sources.filter((s) => !failed[s]);
  const src = usable[Math.min(current, Math.max(usable.length - 1, 0))];
  return (
    <div className={large ? "product-image large" : "product-image"}>
      {src ? (
        <img
          key={src}
          src={src}
          alt={`${product.name} packaging, image ${sources.indexOf(src) + 1}`}
          width="480"
          height="360"
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setFailed((f) => ({ ...f, [src]: true }))}
        />
      ) : (
        <div className="image-fallback">
          <span aria-hidden="true">✧</span>
          <span>
            Product image
            <br />
            coming soon
          </span>
        </div>
      )}
      {!large && usable.length > 1 && (
        <span className="photo-count">{usable.length} photos</span>
      )}
      {large && usable.length > 1 && (
        <div className="gallery-controls">
          {usable.map((_, i) => (
            <button
              key={i}
              aria-label={`View product image ${i + 1}`}
              aria-pressed={current === i}
              onClick={() => setCurrent(i)}
            >
              {i + 1}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
// "View photo" links for image cells that are web pages with no saved local copy yet.
export function PhotoLinks({ product }: { product: Product }) {
  const { pages } = resolveImages(product, useImageIndex());
  if (!pages.length) return null;
  return (
    <p className="photo-links">
      {pages.map((href, i) => (
        <a key={href} href={href} target="_blank" rel="noopener noreferrer">
          View photo{pages.length > 1 ? ` ${i + 1}` : ""}
          <span className="sr-only"> of {product.name} (opens in a new tab)</span>
        </a>
      ))}
    </p>
  );
}
export function Quantity({
  value,
  max,
  name,
  onChange,
  onRemove,
}: {
  value: number;
  max: number;
  name: string;
  onChange: (v: unknown) => boolean;
  onRemove?: () => void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    if (!onChange(draft)) setDraft(String(value));
  };
  return (
    <div className="quantity">
      <button
        aria-label={
          value <= 1 && onRemove
            ? `Remove ${name} from cart`
            : `Decrease ${name} quantity`
        }
        disabled={value <= 1 && !onRemove}
        onClick={() =>
          value <= 1 && onRemove ? onRemove() : onChange(value - 1)
        }
      >
        −
      </button>
      <input
        aria-label={`${name} quantity`}
        type="text"
        inputMode="numeric"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
        }}
      />
      <button
        aria-label={`Increase ${name} quantity`}
        disabled={value >= max}
        onClick={() => onChange(value + 1)}
      >
        +
      </button>
    </div>
  );
}
