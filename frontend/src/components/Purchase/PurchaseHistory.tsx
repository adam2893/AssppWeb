import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import PageContainer from "../Layout/PageContainer";
import Alert from "../common/Alert";
import AppIcon from "../common/AppIcon";
import { useAccounts } from "../../hooks/useAccounts";
import { getErrorMessage } from "../../utils/error";
import {
  fetchOwnedApps,
  pageOwnedApps,
  DaapAuthError,
  type OwnedApp,
} from "../../apple/purchaseHistory";

/** The full list is fetched up front, so paging happens in memory. */
const PAGE_SIZE = 50;

/** Platform bitmask bits documented by the purchase-history protocol. */
const PLATFORM_BITS: Array<{ bit: number; labelKey: string }> = [
  { bit: 1, labelKey: "purchases.platform.iphone" },
  { bit: 2, labelKey: "purchases.platform.ipad" },
  { bit: 8, labelKey: "purchases.platform.macos" },
  { bit: 16, labelKey: "purchases.platform.visionos" },
];

const chipClassName =
  "inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium leading-none text-gray-500 dark:bg-gray-800 dark:text-gray-400";

type LoadStatus = "idle" | "loading" | "ready" | "auth" | "error";

export default function PurchaseHistory() {
  const { t } = useTranslation();
  const { accounts, loading: accountsLoading, loadAccounts, updateAccount } =
    useAccounts();

  const [selectedEmail, setSelectedEmail] = useState("");
  const [apps, setApps] = useState<OwnedApp[]>([]);
  /** Which account the currently held `apps` belong to. */
  const [appsOwner, setAppsOwner] = useState("");
  const [status, setStatus] = useState<LoadStatus>("idle");
  const [errorMessage, setErrorMessage] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [reloadToken, setReloadToken] = useState(0);

  // Refs let the fetch effect read the latest values without re-running when
  // they change (updating cookies must not retrigger a fetch).
  const accountsRef = useRef(accounts);
  accountsRef.current = accounts;
  const tRef = useRef(t);
  tRef.current = t;

  useEffect(() => {
    loadAccounts();
  }, [loadAccounts]);

  // Pick the first account once accounts are available.
  useEffect(() => {
    if (!selectedEmail && accounts.length > 0) {
      setSelectedEmail(accounts[0].email);
    }
  }, [accounts, selectedEmail]);

  // Fetch owned apps whenever the account changes or a refresh is requested.
  useEffect(() => {
    if (!selectedEmail) {
      setStatus("idle");
      setApps([]);
      setAppsOwner("");
      return;
    }

    const account = accountsRef.current.find((a) => a.email === selectedEmail);
    if (!account) return;

    let cancelled = false;
    setStatus("loading");
    setErrorMessage("");

    (async () => {
      try {
        const result = await fetchOwnedApps(account);
        if (cancelled) return;
        setApps(result.apps);
        setAppsOwner(selectedEmail);
        setStatus("ready");
        // Persist refreshed cookies; the ref-based read above keeps this from
        // retriggering the effect.
        void updateAccount({ ...account, cookies: result.updatedCookies });
      } catch (error) {
        if (cancelled) return;
        if (error instanceof DaapAuthError) {
          setStatus("auth");
          setApps([]);
          setAppsOwner("");
        } else {
          setStatus("error");
          setErrorMessage(
            getErrorMessage(error, tRef.current("purchases.errorTitle")),
          );
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [selectedEmail, reloadToken, updateAccount]);

  // Any change to the filter or account starts back at the first page.
  useEffect(() => {
    setPage(0);
  }, [query, selectedEmail]);

  const hasData = appsOwner === selectedEmail && selectedEmail !== "";

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return apps;
    return apps.filter(
      (app) =>
        app.name.toLowerCase().includes(needle) ||
        app.bundleId.toLowerCase().includes(needle),
    );
  }, [apps, query]);

  const total = filtered.length;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const pageItems = pageOwnedApps(filtered, safePage, PAGE_SIZE);

  const showSelector = accounts.length > 0;
  // Keep the filter visible even when it matches nothing, so it can be cleared.
  const showFilter = hasData && apps.length > 0;

  return (
    <PageContainer
      title={t("purchases.title")}
      action={
        selectedEmail ? (
          <button
            type="button"
            onClick={() => setReloadToken((n) => n + 1)}
            disabled={status === "loading"}
            className="inline-flex min-h-10 items-center gap-2 rounded-full bg-white px-4 py-2 text-sm font-semibold text-gray-700 shadow-sm ring-1 ring-black/5 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-gray-900 dark:text-gray-200 dark:ring-white/10 dark:hover:bg-gray-800"
          >
            <RefreshIcon spinning={status === "loading"} />
            <span>
              {status === "loading"
                ? t("purchases.refreshing")
                : t("purchases.refresh")}
            </span>
          </button>
        ) : undefined
      }
    >
      <div className="min-w-0 space-y-5">
        {showSelector && (
          <div className="rounded-3xl bg-white p-4 shadow-sm ring-1 ring-black/5 dark:bg-gray-900 dark:ring-white/10 sm:p-5">
            <label
              htmlFor="purchases-account"
              className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300"
            >
              {t("purchases.account")}
            </label>
            <select
              id="purchases-account"
              value={selectedEmail}
              onChange={(e) => setSelectedEmail(e.target.value)}
              className="block min-w-0 max-w-full w-full truncate rounded-xl border border-gray-300/90 bg-gray-100 px-3.5 py-2.5 text-base text-gray-900 shadow-sm shadow-gray-950/5 outline-none transition-colors focus:border-blue-500 focus:ring-4 focus:ring-blue-500/15 dark:border-gray-700 dark:bg-gray-800 dark:text-white dark:shadow-black/20"
            >
              {accounts.map((a) => (
                <option key={a.email} value={a.email}>
                  {a.firstName} {a.lastName} ({a.email})
                </option>
              ))}
            </select>
          </div>
        )}

        {showFilter && (
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("purchases.filterPlaceholder")}
              aria-label={t("purchases.filterPlaceholder")}
              className="min-h-11 w-full min-w-0 flex-1 rounded-2xl border-0 bg-white px-4 py-2.5 text-base text-gray-900 shadow-sm ring-1 ring-black/5 placeholder:text-gray-500 focus:ring-2 focus:ring-blue-500/40 dark:bg-gray-900 dark:text-white dark:ring-white/10 dark:placeholder:text-gray-400"
            />
            <p className="shrink-0 px-1 text-xs font-medium text-gray-500 dark:text-gray-400 sm:text-right">
              {t("purchases.count", { total })}
            </p>
          </div>
        )}

        {accountsLoading && accounts.length === 0 ? (
          <LoadingSkeleton label={t("loading")} />
        ) : accounts.length === 0 ? (
          <EmptyState
            title={t("purchases.noAccounts")}
            description={t("purchases.noAccountsDesc")}
            action={
              <Link
                to="/accounts/add"
                className="inline-flex min-h-11 items-center gap-2 rounded-full bg-blue-600 px-6 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700"
              >
                {t("purchases.noAccountsLink")}
              </Link>
            }
          />
        ) : status === "auth" ? (
          <div className="space-y-4">
            <Alert type="warning">
              <p className="font-semibold">{t("purchases.authTitle")}</p>
              <p className="mt-1">{t("purchases.authDesc")}</p>
            </Alert>
            <Link
              to={`/accounts/${encodeURIComponent(selectedEmail)}`}
              className="inline-flex min-h-11 items-center gap-2 rounded-full bg-blue-600 px-6 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700"
            >
              {t("purchases.authAction")}
            </Link>
          </div>
        ) : status === "error" ? (
          <div className="space-y-4">
            <Alert type="error">
              <p className="font-semibold">{t("purchases.errorTitle")}</p>
              <p className="mt-1 break-words">{errorMessage}</p>
            </Alert>
            <button
              type="button"
              onClick={() => setReloadToken((n) => n + 1)}
              className="inline-flex min-h-11 items-center gap-2 rounded-full bg-blue-600 px-6 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700"
            >
              {t("purchases.errorRetry")}
            </button>
          </div>
        ) : !hasData ? (
          <LoadingSkeleton label={t("purchases.loading")} />
        ) : total === 0 ? (
          query.trim() ? (
            <EmptyState
              title={t("purchases.filterEmpty")}
              description={t("purchases.filterEmptyDesc")}
            />
          ) : (
            <EmptyState
              title={t("purchases.empty")}
              description={t("purchases.emptyDesc")}
            />
          )
        ) : (
          <>
            <div className="overflow-hidden rounded-3xl bg-white shadow-sm ring-1 ring-black/5 dark:bg-gray-900 dark:ring-white/10">
              <ul className="divide-y divide-gray-100 dark:divide-gray-800">
                {pageItems.map((app, index) => (
                  <PurchaseRow
                    key={app.adamId}
                    app={app}
                    index={index}
                    labels={{
                      platforms: PLATFORM_BITS.filter(
                        (p) => (app.platformBitmask & p.bit) !== 0,
                      ).map((p) => t(p.labelKey)),
                      unknownDate: t("purchases.unknownDate"),
                    }}
                  />
                ))}
              </ul>
            </div>

            {total > PAGE_SIZE && (
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  {t("purchases.range", {
                    from: safePage * PAGE_SIZE + 1,
                    to: Math.min((safePage + 1) * PAGE_SIZE, total),
                    total,
                  })}
                </p>
                <div className="flex items-center gap-2">
                  <PagerButton
                    onClick={() => setPage(Math.max(0, safePage - 1))}
                    disabled={safePage === 0}
                  >
                    ‹ {t("purchases.prev")}
                  </PagerButton>
                  <span className="text-xs font-medium tabular-nums text-gray-500 dark:text-gray-400">
                    {safePage + 1} / {pageCount}
                  </span>
                  <PagerButton
                    onClick={() =>
                      setPage(Math.min(pageCount - 1, safePage + 1))
                    }
                    disabled={safePage >= pageCount - 1}
                  >
                    {t("purchases.next")} ›
                  </PagerButton>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </PageContainer>
  );
}

function PurchaseRow({
  app,
  index,
  labels,
}: {
  app: OwnedApp;
  index: number;
  labels: { platforms: string[]; unknownDate: string };
}) {
  const displayName = app.name || app.bundleId || String(app.adamId);
  const dateLabel = formatPurchaseDate(app.purchaseDate);

  return (
    <li
      className="animate-list-row flex items-center gap-4 p-4"
      style={{ animationDelay: `${Math.min(index, 12) * 20}ms` }}
    >
      <AppIcon name={displayName} size="sm" />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-3">
          <p className="min-w-0 flex-1 truncate font-semibold text-gray-900 dark:text-white">
            {displayName}
          </p>
          <time
            className="shrink-0 text-xs text-gray-400 dark:text-gray-500"
            title={dateLabel ? undefined : labels.unknownDate}
          >
            {dateLabel ?? labels.unknownDate}
          </time>
        </div>
        {app.bundleId && (
          <p className="mt-0.5 truncate text-sm text-gray-500 dark:text-gray-400">
            {app.bundleId}
          </p>
        )}
        {(app.version || labels.platforms.length > 0) && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {app.version && (
              <span className={chipClassName}>{`v${app.version}`}</span>
            )}
            {labels.platforms.map((label) => (
              <span key={label} className={chipClassName}>
                {label}
              </span>
            ))}
          </div>
        )}
      </div>
    </li>
  );
}

function PagerButton({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void;
  disabled: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex min-h-9 items-center rounded-full bg-white px-3.5 text-sm font-medium text-gray-700 shadow-sm ring-1 ring-black/5 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-gray-900 dark:text-gray-200 dark:ring-white/10 dark:hover:bg-gray-800"
    >
      {children}
    </button>
  );
}

function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-3xl bg-white px-6 py-16 text-center shadow-sm ring-1 ring-black/5 dark:bg-gray-900 dark:ring-white/10">
      <div className="mb-5 flex h-16 w-16 items-center justify-center rounded-2xl bg-blue-50 dark:bg-blue-950">
        <svg
          aria-hidden="true"
          className="h-8 w-8 text-blue-600 dark:text-blue-400"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={1.5}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M15.75 10.5V6a3.75 3.75 0 1 0-7.5 0v4.5m11.356-1.993 1.263 12c.07.665-.45 1.243-1.119 1.243H4.25a1.125 1.125 0 0 1-1.12-1.243l1.264-12A1.125 1.125 0 0 1 5.513 7.5h12.974c.576 0 1.059.435 1.119 1.007Z"
          />
        </svg>
      </div>
      <h3 className="mb-2 text-lg font-semibold text-gray-900 dark:text-white">
        {title}
      </h3>
      <p className="mb-6 max-w-full text-[clamp(0.6875rem,2.8vw,0.875rem)] leading-relaxed tracking-[-0.015em] text-gray-500 dark:text-gray-400">
        {description}
      </p>
      {action}
    </div>
  );
}

function LoadingSkeleton({ label }: { label: string }) {
  return (
    <div>
      <p className="sr-only" role="status" aria-live="polite">
        {label}
      </p>
      <div className="overflow-hidden rounded-3xl bg-white shadow-sm ring-1 ring-black/5 dark:bg-gray-900 dark:ring-white/10">
        <ul className="divide-y divide-gray-100 dark:divide-gray-800">
          {Array.from({ length: 6 }).map((_, i) => (
            <li key={i} className="flex items-center gap-4 p-4">
              <div className="h-10 w-10 shrink-0 animate-pulse rounded-[22%] bg-gray-200 dark:bg-gray-800" />
              <div className="min-w-0 flex-1 space-y-2">
                <div className="h-4 w-2/5 animate-pulse rounded-full bg-gray-200 dark:bg-gray-800" />
                <div className="h-3 w-3/5 animate-pulse rounded-full bg-gray-100 dark:bg-gray-800/70" />
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function RefreshIcon({ spinning }: { spinning: boolean }) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      className={`h-4 w-4 shrink-0 ${spinning ? "animate-spin" : ""}`}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99"
      />
    </svg>
  );
}

function formatPurchaseDate(seconds: number): string | null {
  if (!seconds) return null;
  const date = new Date(seconds * 1000);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString();
}
