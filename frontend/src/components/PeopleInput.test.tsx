// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { PeopleInput } from "./PeopleInput";

afterEach(cleanup);
const people = [{ key: "ana", name: "Ana", count: 3 }, { key: "bruno", name: "Bruno", count: 1 }];
let last: string[] = [];
function Harness({ start = [] as string[] }) {
  const [v, setV] = useState(start);
  last = v;
  return <PeopleInput label="Going with" value={v} onChange={setV} people={people} />;
}
const box = () => screen.getByRole("combobox");

describe("PeopleInput", () => {
  it("adds typed names on Enter and comma, and skips duplicates", () => {
    render(<Harness />);
    fireEvent.change(box(), { target: { value: "Carla" } });
    fireEvent.keyDown(box(), { key: "Enter" });
    fireEvent.change(box(), { target: { value: "carla" } });
    fireEvent.keyDown(box(), { key: "," });
    fireEvent.change(box(), { target: { value: "Dani" } });
    fireEvent.keyDown(box(), { key: "," });
    expect(last).toEqual(["Carla", "Dani"]);
  });
  it("suggests known people and picks one with the keyboard", () => {
    render(<Harness start={["Bruno"]} />);
    fireEvent.focus(box());
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["Ana"]); // Bruno is already on the list
    fireEvent.keyDown(box(), { key: "ArrowDown" });
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(last).toEqual(["Bruno", "Ana"]);
  });
  it("removes with the × button and with Backspace on an empty box", () => {
    render(<Harness start={["Ana", "Bruno"]} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove Ana" }));
    expect(last).toEqual(["Bruno"]);
    fireEvent.keyDown(box(), { key: "Backspace" });
    expect(last).toEqual([]);
  });
  it("keeps a name typed but not yet confirmed when the box loses focus", () => {
    render(<Harness />);
    fireEvent.change(box(), { target: { value: "Eva" } });
    fireEvent.blur(box());
    expect(last).toEqual(["Eva"]);
  });
});
