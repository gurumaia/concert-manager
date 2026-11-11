// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VenuesPage } from "./VenuesPage";

const venue = { id: "v1", name: "Tokio Marine Hall", city: "São Paulo", capacity: 2500, eventCount: 2, createdAt: "", updatedAt: "" };
let ops: Array<{ name: string; body: any }>;

function mockApi() {
  ops = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/config") return new Response(JSON.stringify({ devAuth: true }));
    ops.push({ name: url.split("/").pop()!, body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ ok: true, result: {} }));
  }));
}

// jsdom does not implement <dialog> modal methods.
HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("VenuesPage capacity", () => {
  it("shows the capacity on the list with a thousands separator", () => {
    mockApi();
    render(<VenuesPage venues={[venue, { ...venue, id: "v2", name: "No Capacity", capacity: undefined }]} reload={vi.fn()} />);
    expect(screen.getByText("Capacity 2,500")).toBeTruthy();
    expect(screen.getAllByText(/^Capacity /)).toHaveLength(1);
  });

  async function saveWith(value: string) {
    mockApi();
    render(<VenuesPage venues={[venue]} reload={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Tokio Marine Hall/ }));
    const input = screen.getByLabelText(/^Capacity/) as HTMLInputElement;
    expect(input.value).toBe("2500");
    fireEvent.change(input, { target: { value } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(ops.some((o) => o.name === "update_venue")).toBe(true));
    return ops.find((o) => o.name === "update_venue")!.body.changes.capacity;
  }

  it("saves capacity as a number, ignoring thousands separators", async () => {
    expect(await saveWith("3.000")).toBe(3000);
  });

  it("clears capacity when the field is emptied", async () => {
    expect(await saveWith("")).toBeNull();
  });
});
