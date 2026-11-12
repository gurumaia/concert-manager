// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EventView, PhotoView } from "../types";

const op = vi.fn();
vi.mock("../api", () => ({ op: (...a: unknown[]) => op(...a) }));
const uploadPhoto = vi.fn();
vi.mock("../photos", () => ({ MAX_PHOTOS: 20, uploadPhoto: (...a: unknown[]) => uploadPhoto(...a) }));
const { PhotosSection } = await import("./PhotosSection");

const event: EventView = { id: "e1", title: "Slayer", date: "2020-01-01", createdAt: "", updatedAt: "", venue: null, rsvp: null, past: true };
const photo = (id: string, extra: Partial<PhotoView> = {}): PhotoView => ({
  id, eventId: "e1", contentType: "image/jpeg", bytes: 10, sharedWith: [], createdAt: "", url: `https://s/${id}`, thumbUrl: `https://s/${id}.t`, mine: true, ...extra,
});
// jsdom has no <dialog> modal support.
HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) { this.setAttribute("open", ""); };
HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) { this.removeAttribute("open"); };
afterEach(() => { cleanup(); op.mockReset(); uploadPhoto.mockReset(); vi.restoreAllMocks(); });

describe("PhotosSection", () => {
  it("says photos are private and shows badges only for shared ones", async () => {
    op.mockResolvedValue([photo("a"), photo("b", { sharedWith: ["her@example.com"] }), photo("c", { publicUrl: "https://app/api/public/photos/tok" })]);
    render(<PhotosSection event={event} />);
    await screen.findByRole("button", { name: "Open photo 1" });
    expect(screen.getByText(/Only you can see/)).toBeTruthy();
    expect(screen.getAllByText("Shared")).toHaveLength(1);
    expect(screen.getAllByText("Public")).toHaveLength(1);
    expect(op).toHaveBeenCalledWith("list_photos", { eventId: "e1" });
  });

  it("tells the parent when photos are added, and scrolls itself into view when asked", async () => {
    op.mockResolvedValue([]);
    uploadPhoto.mockResolvedValue(photo("n"));
    const onChange = vi.fn();
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    const { container } = render(<PhotosSection event={event} scrollTo onChange={onChange} />);
    await screen.findByRole("button", { name: "Add photos" });
    expect(scroll).toHaveBeenCalled();
    fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [new File(["x"], "a.jpg")] } });
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
  });

  it("asks for photos of the owner when viewing a shared show, and hides itself when none", async () => {
    op.mockResolvedValue([]);
    const { container } = render(<PhotosSection event={event} ownerId="owner1" readOnly />);
    await waitFor(() => expect(op).toHaveBeenCalledWith("list_photos", { eventId: "e1", ownerId: "owner1" }));
    expect(container.textContent).toBe("");
  });

  it("uploads each chosen file and adds it to the grid; reports a failure without stopping the rest", async () => {
    op.mockResolvedValue([]);
    uploadPhoto.mockRejectedValueOnce(new Error("bad.heic can't be read")).mockResolvedValueOnce(photo("n"));
    const { container } = render(<PhotosSection event={event} />);
    await screen.findByRole("button", { name: "Add photos" });
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(["x"], "bad.heic"), new File(["y"], "ok.jpg")] } });
    await screen.findByRole("button", { name: "Open photo 1" });
    expect(uploadPhoto).toHaveBeenCalledTimes(2);
    expect((await screen.findByRole("alert")).textContent).toContain("bad.heic");
  });

  it("makes a photo public only after confirming, and shows the link to copy", async () => {
    op.mockResolvedValueOnce([photo("a")]);
    render(<PhotosSection event={event} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open photo 1" }));
    const dlg = within(await screen.findByRole("dialog"));
    const box = (await dlg.findByRole("checkbox", { name: /Public link/ })) as HTMLInputElement;

    vi.spyOn(window, "confirm").mockReturnValueOnce(false);
    fireEvent.click(box);
    expect(op).toHaveBeenCalledTimes(1); // declined: nothing sent

    vi.spyOn(window, "confirm").mockReturnValueOnce(true);
    op.mockResolvedValueOnce([photo("a", { publicUrl: "https://app/api/public/photos/tok" })]);
    fireEvent.click(box);
    await waitFor(() => expect(op).toHaveBeenCalledWith("set_photos_public", { eventId: "e1", photoIds: ["a"], enabled: true }));
    expect(((await dlg.findByLabelText("Public link", { selector: "input[readonly]" })) as HTMLInputElement).value).toBe("https://app/api/public/photos/tok");
  });

  it("shares with an email", async () => {
    op.mockResolvedValueOnce([photo("a")]);
    render(<PhotosSection event={event} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open photo 1" }));
    const dlg = within(await screen.findByRole("dialog"));
    fireEvent.change(await dlg.findByLabelText("Email to share photos with"), { target: { value: "her@example.com" } });
    op.mockResolvedValueOnce([photo("a", { sharedWith: ["her@example.com"] })]);
    fireEvent.click(dlg.getByRole("button", { name: "Share" }));
    await waitFor(() => expect(op).toHaveBeenCalledWith("share_photos", { eventId: "e1", photoIds: ["a"], emails: ["her@example.com"] }));
    expect(await dlg.findByText("her@example.com")).toBeTruthy();
  });
});
