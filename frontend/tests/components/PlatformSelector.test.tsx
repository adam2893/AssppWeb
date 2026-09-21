import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import PlatformSelector from "../../src/components/common/PlatformSelector";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

afterEach(cleanup);

describe("PlatformSelector", () => {
  it("renders one option per platform from the shared contract", () => {
    render(<PlatformSelector value="iphone" onChange={() => {}} />);

    const options = screen.getAllByRole("radio");
    expect(options).toHaveLength(3);
    expect(options.map((o) => o.textContent)).toEqual([
      "platform.iphone",
      "platform.ipad",
      "platform.appletv",
    ]);
    expect(screen.getByRole("radiogroup")).toHaveAttribute(
      "aria-label",
      "platform.label",
    );
  });

  it("marks only the selected platform as checked", () => {
    render(<PlatformSelector value="appletv" onChange={() => {}} />);

    expect(
      screen.getByRole("radio", { name: "platform.appletv" }),
    ).toHaveAttribute("aria-checked", "true");
    expect(
      screen.getByRole("radio", { name: "platform.iphone" }),
    ).toHaveAttribute("aria-checked", "false");
  });

  it("reports the clicked platform", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<PlatformSelector value="iphone" onChange={onChange} />);

    await user.click(screen.getByRole("radio", { name: "platform.ipad" }));

    expect(onChange).toHaveBeenCalledWith("ipad");
  });

  it("moves the selection with arrow keys", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<PlatformSelector value="iphone" onChange={onChange} />);

    screen.getByRole("radio", { name: "platform.iphone" }).focus();
    await user.keyboard("{ArrowRight}");

    expect(onChange).toHaveBeenCalledWith("ipad");
  });

  it("wraps from the last platform back to the first", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<PlatformSelector value="appletv" onChange={onChange} />);

    screen.getByRole("radio", { name: "platform.appletv" }).focus();
    await user.keyboard("{ArrowRight}");

    expect(onChange).toHaveBeenCalledWith("iphone");
  });

  it("renders a select variant with all three platforms", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <PlatformSelector
        id="platform"
        variant="select"
        value="iphone"
        onChange={onChange}
      />,
    );

    const select = screen.getByRole("combobox");
    expect(select).toHaveValue("iphone");
    await user.selectOptions(select, "appletv");
    expect(onChange).toHaveBeenCalledWith("appletv");
  });
});
