// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const uploadPhoto = vi.fn();
vi.mock("./photos", () => ({ uploadPhoto: (...a: unknown[]) => uploadPhoto(...a) }));
const { usePhotoDrop } = await import("./usePhotoDrop");

function Target({ onUploaded }: { onUploaded?: (n: number) => void }) {
  const { state, handlers } = usePhotoDrop("e1", onUploaded);
  return (
    <div data-testid="t" data-dragging={state.dragging} {...handlers}>
      {state.status && <p role="status">{state.status}</p>}
      {state.error && <p role="alert">{state.error}</p>}
    </div>
  );
}
const img = (n: string) => new File(["x"], n, { type: "image/jpeg" });
const drag = (files: File[], types = ["Files"]) => ({ dataTransfer: { files, types, dropEffect: "" } });
afterEach(() => { cleanup(); uploadPhoto.mockReset(); });

describe("usePhotoDrop", () => {
  it("highlights while files are dragged over and ignores non-file drags (text, links)", () => {
    render(<Target />);
    const t = screen.getByTestId("t");
    fireEvent.dragEnter(t, drag([], ["text/plain"]));
    expect(t.dataset.dragging).toBe("false");
    fireEvent.dragEnter(t, drag([img("a.jpg")]));
    expect(t.dataset.dragging).toBe("true");
    fireEvent.dragEnter(t, drag([img("a.jpg")])); // entering a child
    fireEvent.dragLeave(t, drag([img("a.jpg")]));
    expect(t.dataset.dragging).toBe("true"); // still inside
    fireEvent.dragLeave(t, drag([img("a.jpg")]));
    expect(t.dataset.dragging).toBe("false");
  });

  it("uploads every dropped photo to that show, in order, and reports it", async () => {
    uploadPhoto.mockResolvedValue({});
    const onUploaded = vi.fn();
    render(<Target onUploaded={onUploaded} />);
    const a = img("a.jpg"), b = img("b.jpg");
    fireEvent.drop(screen.getByTestId("t"), drag([a, b]));
    expect((await screen.findByRole("status")).textContent).toBe("Added 2 photos.");
    expect(uploadPhoto.mock.calls).toEqual([["e1", a], ["e1", b]]);
    expect(onUploaded).toHaveBeenCalledWith(2);
    expect(screen.getByTestId("t").dataset.dragging).toBe("false");
  });

  it("skips non-images, keeps going after a failure, and says what went wrong", async () => {
    uploadPhoto.mockRejectedValueOnce(new Error("bad.jpg can't be read")).mockResolvedValueOnce({});
    render(<Target />);
    fireEvent.drop(screen.getByTestId("t"), drag([img("bad.jpg"), img("ok.jpg"), new File(["x"], "notes.pdf", { type: "application/pdf" })]));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Added 1 photo."));
    expect(uploadPhoto).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("alert").textContent).toContain("bad.jpg can't be read");
    expect(screen.getByRole("alert").textContent).toContain("1 file was not a photo.");
  });

  it("stops at the first 'show is full' error instead of failing every remaining file", async () => {
    uploadPhoto.mockRejectedValue(new Error("A show can have at most 20 photos. Delete one first."));
    render(<Target />);
    fireEvent.drop(screen.getByTestId("t"), drag([img("1.jpg"), img("2.jpg"), img("3.jpg")]));
    expect((await screen.findByRole("alert")).textContent).toContain("at most 20");
    expect(uploadPhoto).toHaveBeenCalledTimes(1);
  });

  it("refuses a drop that has no photos at all", async () => {
    render(<Target />);
    fireEvent.drop(screen.getByTestId("t"), drag([new File(["x"], "a.txt", { type: "text/plain" })]));
    expect((await screen.findByRole("alert")).textContent).toContain("Only photos");
    expect(uploadPhoto).not.toHaveBeenCalled();
  });
});
