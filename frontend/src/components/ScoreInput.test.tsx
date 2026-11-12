// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { ScoreInput } from "./ScoreInput";

afterEach(cleanup);
let last: number | null = null;
function Harness({ start = null as number | null }) {
  const [v, setV] = useState(start);
  last = v;
  return <ScoreInput value={v} onChange={setV} />;
}

describe("ScoreInput", () => {
  it("starts unrated, not at 0", () => {
    render(<Harness />);
    expect(last).toBeNull();
    expect((screen.getByLabelText("Score, 0 to 10") as HTMLInputElement).value).toBe("");
  });
  it("slider and number box stay in sync", () => {
    render(<Harness />);
    fireEvent.change(screen.getByLabelText("Score slider"), { target: { value: "7.5" } });
    expect(last).toBe(7.5);
    expect((screen.getByLabelText("Score, 0 to 10") as HTMLInputElement).value).toBe("7.5");
  });
  it("rounds typed values to 0.5, clamps to 0-10, accepts a comma, and 0 is a real score", () => {
    render(<Harness />);
    const box = screen.getByLabelText("Score, 0 to 10");
    fireEvent.change(box, { target: { value: "8,3" } }); fireEvent.blur(box);
    expect(last).toBe(8.5);
    fireEvent.change(box, { target: { value: "42" } }); fireEvent.blur(box);
    expect(last).toBe(10);
    fireEvent.change(box, { target: { value: "0" } }); fireEvent.blur(box);
    expect(last).toBe(0);
  });
  it("clears back to unrated", () => {
    render(<Harness start={6} />);
    fireEvent.click(screen.getByText("Clear"));
    expect(last).toBeNull();
  });
});
