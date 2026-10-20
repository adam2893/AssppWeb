import { useTranslation } from "react-i18next";
import type { AuthenticationDiagnostics } from "../../apple/authenticate";

interface AuthDiagnosticsProps {
  diagnostics: AuthenticationDiagnostics;
}

const FAILURE_REASON_KEYS = new Set([
  "sap-assets-unavailable",
  "sap-signing-unavailable",
  "wisp-unavailable",
  "redirect-location-missing",
  "two-factor-required",
  "account-info-missing",
  "account-address-missing",
  "authentication-failed",
]);

export default function AuthDiagnostics({ diagnostics }: AuthDiagnosticsProps) {
  const { t } = useTranslation();
  const failureReason = diagnostics.failureReason;
  const isSafeHttpReason =
    failureReason !== undefined && /^HTTP \d{3}( empty response)?$/.test(failureReason);
  const displayFailure = failureReason
    ? isSafeHttpReason || !FAILURE_REASON_KEYS.has(failureReason)
      ? isSafeHttpReason
        ? failureReason
        : t("accounts.authDiagnostics.failureReasons.authentication-failed")
      : t(`accounts.authDiagnostics.failureReasons.${failureReason}`)
    : "--";

  return (
    <section
      className="rounded-3xl bg-white p-5 shadow-sm ring-1 ring-black/5 dark:bg-gray-900 dark:ring-white/10 sm:p-6"
      aria-live="polite"
    >
      <h2 className="text-base font-semibold text-gray-900 dark:text-white">
        {t("accounts.authDiagnostics.title")}
      </h2>
      <dl className="mt-4 divide-y divide-gray-100 dark:divide-gray-800">
        <DiagnosticRow
          label={t("accounts.authDiagnostics.bagFetchStatus")}
          value={t(`accounts.authDiagnostics.values.${diagnostics.bagFetchStatus}`)}
        />
        <DiagnosticRow
          label={t("accounts.authDiagnostics.resolvedAuthEndpoint")}
          value={diagnostics.resolvedAuthEndpoint ?? "--"}
        />
        <DiagnosticRow
          label={t("accounts.authDiagnostics.pod")}
          value={diagnostics.pod ?? "--"}
        />
        <DiagnosticRow
          label={t("accounts.authDiagnostics.storefront")}
          value={diagnostics.storefront ?? "--"}
        />
        <DiagnosticRow
          label={t("accounts.authDiagnostics.sapAssetReadiness")}
          value={t(`accounts.authDiagnostics.values.${diagnostics.sapAssetReadiness}`)}
        />
        <DiagnosticRow
          label={t("accounts.authDiagnostics.wispConnection")}
          value={t(`accounts.authDiagnostics.values.${diagnostics.wispConnection}`)}
        />
        <DiagnosticRow
          label={t("accounts.authDiagnostics.lastAppleStatusCode")}
          value={diagnostics.lastAppleStatusCode?.toString() ?? "--"}
        />
        <DiagnosticRow
          label={t("accounts.authDiagnostics.retryCount")}
          value={diagnostics.retryCount.toString()}
        />
        <DiagnosticRow
          label={t("accounts.authDiagnostics.retryDelay")}
          value={
            diagnostics.retryDelayMs === undefined
              ? "--"
              : t("accounts.authDiagnostics.delayValue", {
                  milliseconds: diagnostics.retryDelayMs,
                })
          }
        />
        <DiagnosticRow
          label={t("accounts.authDiagnostics.failureReason")}
          value={displayFailure}
        />
      </dl>
    </section>
  );
}

function DiagnosticRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="py-3 first:pt-0 last:pb-0">
      <dt className="text-sm font-medium text-gray-500 dark:text-gray-400">{label}</dt>
      <dd className="mt-0.5 break-all text-sm text-gray-900 dark:text-white">{value}</dd>
    </div>
  );
}
