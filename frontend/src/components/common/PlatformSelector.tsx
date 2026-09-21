import { useRef, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { PLATFORMS, type PlatformId } from "../../apple/platform";

/**
 * Order is taken from the shared platform contract so the UI never keeps its
 * own copy of the platform list.
 */
const PLATFORM_IDS = Object.keys(PLATFORMS) as PlatformId[];

interface PlatformSelectorProps {
  value: PlatformId;
  onChange: (id: PlatformId) => void;
  /** `segmented` (search) or `select` (settings). */
  variant?: "segmented" | "select";
  disabled?: boolean;
  className?: string;
  id?: string;
}

export default function PlatformSelector({
  value,
  onChange,
  variant = "segmented",
  disabled = false,
  className = "",
  id,
}: PlatformSelectorProps) {
  const { t } = useTranslation();

  if (variant === "select") {
    return (
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value as PlatformId)}
        disabled={disabled}
        className={`block min-w-0 max-w-full w-full truncate rounded-md border border-gray-300 bg-white px-3 py-2 text-base text-gray-900 transition-colors focus:border-blue-500 focus:ring-1 focus:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-60 dark:border-gray-700 dark:bg-gray-800 dark:text-white ${className}`}
      >
        {PLATFORM_IDS.map((platformId) => (
          <option key={platformId} value={platformId}>
            {t(`platform.${platformId}`)}
          </option>
        ))}
      </select>
    );
  }

  return (
    <Segmented
      value={value}
      onChange={onChange}
      disabled={disabled}
      className={className}
    />
  );
}

function Segmented({
  value,
  onChange,
  disabled,
  className,
}: {
  value: PlatformId;
  onChange: (id: PlatformId) => void;
  disabled: boolean;
  className: string;
}) {
  const { t } = useTranslation();
  const buttonsRef = useRef<Array<HTMLButtonElement | null>>([]);

  function selectAt(index: number) {
    const nextId =
      PLATFORM_IDS[(index + PLATFORM_IDS.length) % PLATFORM_IDS.length];
    onChange(nextId);
    buttonsRef.current[PLATFORM_IDS.indexOf(nextId)]?.focus();
  }

  function handleKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (disabled) return;
    const index = PLATFORM_IDS.indexOf(value);
    switch (e.key) {
      case "ArrowRight":
      case "ArrowDown":
        e.preventDefault();
        selectAt(index + 1);
        break;
      case "ArrowLeft":
      case "ArrowUp":
        e.preventDefault();
        selectAt(index - 1);
        break;
      case "Home":
        e.preventDefault();
        selectAt(0);
        break;
      case "End":
        e.preventDefault();
        selectAt(PLATFORM_IDS.length - 1);
        break;
    }
  }

  return (
    <div
      role="radiogroup"
      aria-label={t("platform.label")}
      onKeyDown={handleKeyDown}
      className={`inline-flex w-full items-stretch rounded-full bg-gray-100 p-0.5 ring-1 ring-inset ring-black/5 dark:bg-gray-800 dark:ring-white/5 ${className}`}
    >
      {PLATFORM_IDS.map((platformId, index) => {
        const selected = platformId === value;
        return (
          <button
            key={platformId}
            ref={(el) => {
              buttonsRef.current[index] = el;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            disabled={disabled}
            onClick={() => onChange(platformId)}
            className={`flex min-h-10 flex-1 items-center justify-center whitespace-nowrap rounded-full px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60 disabled:cursor-not-allowed disabled:opacity-50 ${
              selected
                ? "bg-blue-600 text-white shadow-sm shadow-blue-950/20 dark:bg-blue-500"
                : "text-gray-600 hover:text-gray-900 dark:text-gray-300 dark:hover:text-white"
            }`}
          >
            {t(`platform.${platformId}`)}
          </button>
        );
      })}
    </div>
  );
}
