import { RadioGroup, RadioGroupItem } from "../../src/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "../../src/components/ui/select";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { Badge } from "../../src/components/ui/badge";
import { Button } from "../../src/components/ui/button";
import { Input } from "../../src/components/ui/input";
import { InputDeviceSetting } from "../../src/components/InputDeviceSetting";
import { Label } from "../../src/components/ui/label";
import { createRef } from "react";
import userEvent from "@testing-library/user-event";

beforeEach(() => {
  // Jsdom does not implement pointer capture or scrolling; leave Radix itself real.
  vi.stubGlobal("PointerEvent", MouseEvent);
  Object.defineProperties(HTMLElement.prototype, {
    hasPointerCapture: { configurable: true, value: () => false },
    releasePointerCapture: {
      configurable: true,
      value: () => {
        void 0;
      },
    },
    scrollIntoView: {
      configurable: true,
      value: () => {
        void 0;
      },
    },
    setPointerCapture: {
      configurable: true,
      value: () => {
        void 0;
      },
    },
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("UI wrappers", () => {
  it("forwards object refs and input/label props with real focus and typing", async () => {
    const user = userEvent.setup();
    const input = createRef<HTMLInputElement>();
    const label = createRef<HTMLLabelElement>();
    const button = createRef<HTMLButtonElement>();
    const click = vi.fn<() => void>();
    const view = render(
      <>
        <Label ref={label} htmlFor="name">
          Name
        </Label>
        <Input ref={input} id="name" defaultValue="A" />
        <Button ref={button} disabled onClick={click}>
          Save
        </Button>
        <Badge
          role="status" /* oxlint-disable-line jsx-a11y/prefer-tag-over-role -- role is part of the wrapper contract. */
          variant="outline"
          className="custom"
        >
          Draft
        </Badge>
      </>,
    );
    expect(label.current).toBe(screen.getByText("Name"));
    expect(input.current).toBe(screen.getByRole("textbox", { name: "Name" }));
    expect(button.current).toBe(screen.getByRole("button", { name: "Save" }));
    await user.click(screen.getByText("Name"));
    expect(input.current).toHaveFocus();
    await user.type(screen.getByRole("textbox"), "da");
    expect(input.current).toHaveValue("Ada");
    await user.click(screen.getByRole("button"));
    expect(click).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveClass("custom");
    view.unmount();
    expect(input.current).toBeNull();
    expect(label.current).toBeNull();
    expect(button.current).toBeNull();
  });

  it("supports React 19 callback ref cleanup and Button asChild event composition", async () => {
    const cleanup = vi.fn();
    const ref = vi.fn((_node: HTMLButtonElement) => cleanup);
    const childClick = vi.fn<() => void>();
    const parentClick = vi.fn<() => void>();
    const view = render(
      <Button ref={ref} asChild onClick={parentClick}>
        <button type="button" onClick={childClick}>
          Slotted action
        </button>
      </Button>,
    );
    expect(ref).toHaveBeenCalledWith(screen.getByRole("button", { name: "Slotted action" }));
    expect(screen.getAllByRole("button")).toHaveLength(1);
    await userEvent.setup().click(screen.getByRole("button"));
    expect(childClick).toHaveBeenCalledOnce();
    expect(parentClick).toHaveBeenCalledOnce();
    view.unmount();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("forwards radio refs, change handlers and disabled state", async () => {
    const root = createRef<HTMLDivElement>();
    const item = createRef<HTMLButtonElement>();
    const change = vi.fn<(value: string) => void>();
    render(
      <RadioGroup ref={root} aria-label="Mode" defaultValue="one" onValueChange={change}>
        <RadioGroupItem value="one" aria-label="One" />
        <RadioGroupItem ref={item} value="two" aria-label="Two" />
        <RadioGroupItem disabled value="three" aria-label="Three" />
      </RadioGroup>,
    );
    expect(root.current).toBe(screen.getByRole("radiogroup", { name: "Mode" }));
    expect(item.current).toBe(screen.getByRole("radio", { name: "Two" }));
    await userEvent.setup().click(screen.getByRole("radio", { name: "Two" }));
    expect(change).toHaveBeenCalledWith("two");
    expect(item.current).toBeChecked();
    expect(screen.getByRole("radio", { name: "Three" })).toBeDisabled();
  });

  it("selects through the real portal and forwards trigger, content, label, item and separator refs", async () => {
    const user = userEvent.setup();
    const trigger = createRef<HTMLButtonElement>();
    const content = createRef<HTMLDivElement>();
    const label = createRef<HTMLDivElement>();
    const item = createRef<HTMLDivElement>();
    const separator = createRef<HTMLDivElement>();
    const change = vi.fn<(value: string) => void>();
    render(
      <Select defaultValue="one" onValueChange={change}>
        <SelectTrigger ref={trigger} aria-label="Device">
          <SelectValue />
        </SelectTrigger>
        <SelectContent ref={content}>
          <SelectGroup>
            <SelectLabel ref={label}>Devices</SelectLabel>
            <SelectItem value="one">One</SelectItem>
            <SelectSeparator ref={separator} />
            <SelectItem ref={item} value="two">
              Two
            </SelectItem>
            <SelectItem disabled value="three">
              Three
            </SelectItem>
          </SelectGroup>
        </SelectContent>
      </Select>,
    );
    expect(trigger.current).toBe(screen.getByRole("combobox"));
    await user.click(screen.getByRole("combobox"));
    expect(content.current).toBe(screen.getByRole("listbox"));
    expect(label.current).toHaveTextContent("Devices");
    expect(separator.current).toBeInTheDocument();
    expect(item.current).toBe(screen.getByRole("option", { name: "Two" }));
    expect(screen.getByRole("option", { name: "Three" })).toHaveAttribute("aria-disabled", "true");
    await user.click(screen.getByRole("option", { name: "Two" }));
    expect(change).toHaveBeenCalledWith("two");
    expect(screen.getByRole("combobox")).toHaveTextContent("Two");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("loads input devices on opening, filters empty options and maps the system default to null", async () => {
    const user = userEvent.setup();
    const load = vi.fn<() => void>();
    const change = vi.fn<(value: string | null) => void>();
    const props = {
      isLoading: true,
      onChange: change,
      onLoad: load,
      options: [
        { label: "System default", value: "__default__" },
        { label: "USB microphone", value: "USB" },
        { label: "Invalid", value: " " },
        { label: " ", value: "hidden" },
      ],
      value: "USB",
    };
    const view = render(
      <InputDeviceSetting
        isLoading={props.isLoading}
        onChange={props.onChange}
        onLoad={props.onLoad}
        options={props.options}
        value={props.value}
      />,
    );
    await user.click(screen.getByRole("combobox", { name: "Устройство ввода" }));
    expect(load).toHaveBeenCalledOnce();
    expect(screen.getByText("Загрузка устройств…")).toBeVisible();
    expect(screen.getAllByRole("option")).toHaveLength(2);
    await user.click(screen.getByRole("option", { name: "System default" }));
    expect(change).toHaveBeenCalledWith(null);
    view.rerender(
      <InputDeviceSetting
        isLoading={false}
        onChange={props.onChange}
        onLoad={props.onLoad}
        options={props.options}
        value={null}
      />,
    );
    await user.click(screen.getByRole("combobox"));
    await user.click(screen.getByRole("option", { name: "USB microphone" }));
    expect(change).toHaveBeenLastCalledWith("USB");
  });
});
