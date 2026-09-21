import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import ToastContainer from "../../src/components/common/ToastContainer";
import { useToastStore } from "../../src/store/toast";

function toastElement(message: string): HTMLElement {
  const element = screen.getByText(message).closest("div[data-toast-type]");
  if (!element) throw new Error("toast element not found");
  return element as HTMLElement;
}

describe("ToastContainer warning treatment", () => {
  beforeEach(() => {
    useToastStore.setState({ toasts: [] });
  });

  afterEach(() => {
    cleanup();
    useToastStore.setState({ toasts: [] });
  });

  it("gives warnings an accent bar and a triangle icon, not just colour", () => {
    useToastStore.setState({
      toasts: [{ id: "1", message: "missing part", type: "warning" }],
    });

    render(<ToastContainer />);

    const toast = toastElement("missing part");
    expect(toast).toHaveAttribute("data-toast-type", "warning");
    // Structural cue (position) in addition to the amber palette.
    expect(toast).toHaveClass("border-l-amber-400");
    expect(toast).toHaveClass("border-l-[3px]");
    // Distinct icon silhouette (triangle) vs check / cross / info circle.
    expect(toast.querySelector("svg path")?.getAttribute("d")).toContain(
      "10.29 3.86",
    );
  });

  it("keeps warnings non-interruptive like info, not assertive like errors", () => {
    useToastStore.setState({
      toasts: [{ id: "1", message: "missing part", type: "warning" }],
    });

    render(<ToastContainer />);

    const toast = toastElement("missing part");
    expect(toast).toHaveAttribute("role", "status");
    expect(toast).toHaveAttribute("aria-live", "polite");
  });

  it("does not add the warning accent to info or error toasts", () => {
    useToastStore.setState({
      toasts: [
        { id: "1", message: "plain info", type: "info" },
        { id: "2", message: "plain error", type: "error" },
      ],
    });

    render(<ToastContainer />);

    expect(toastElement("plain info")).not.toHaveClass("border-l-amber-400");
    expect(toastElement("plain error")).not.toHaveClass("border-l-amber-400");
  });
});
