"use client";

import { useCallback, useState, type ChangeEvent } from "react";
import { MAX_IMAGES, shrinkImage, thumbUrl } from "@/lib/images";
import type { Attachment } from "@/lib/types";
import { Close, Photo } from "./Icons";

/** Photos picked for the message being written. They are shrunk as soon as they are picked. */
export function useAttachments() {
  const [items, setItems] = useState<Attachment[]>([]);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const add = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;
      setError(null);
      const room = MAX_IMAGES - items.length;
      if (room <= 0) {
        setError(`Up to ${MAX_IMAGES} photos per message.`);
        return;
      }
      setReading(true);
      const added: Attachment[] = [];
      let unreadable = false;
      for (const file of files.slice(0, room)) {
        try {
          added.push(await shrinkImage(file));
        } catch {
          unreadable = true;
        }
      }
      setItems((current) => [...current, ...added].slice(0, MAX_IMAGES));
      setReading(false);
      if (unreadable) setError("That image couldn't be read.");
      else if (files.length > room) setError(`Up to ${MAX_IMAGES} photos per message.`);
    },
    [items.length],
  );

  const remove = useCallback((index: number) => {
    setError(null);
    setItems((current) => current.filter((_, i) => i !== index));
  }, []);

  const clear = useCallback(() => {
    setItems([]);
    setError(null);
  }, []);

  return { items, reading, error, add, remove, clear, full: items.length >= MAX_IMAGES };
}

/** A real file input behind a button: on iPhone this offers the photo library and the camera. */
export function AttachButton({
  onFiles,
  disabled,
  label,
  className = "attach",
}: {
  onFiles: (files: File[]) => void;
  disabled?: boolean;
  label?: string;
  className?: string;
}) {
  function onChange(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    // Clear it so picking the same photo again still fires a change.
    event.target.value = "";
    onFiles(files);
  }
  return (
    <label className={disabled ? `${className} is-disabled` : className}>
      <input type="file" accept="image/*" multiple onChange={onChange} disabled={disabled} />
      <Photo size={label ? 19 : 22} />
      {label ? <span>{label}</span> : <span className="visually-hidden">Add photo</span>}
    </label>
  );
}

export function AttachmentPreviews({
  items,
  reading,
  onRemove,
}: {
  items: Attachment[];
  reading?: boolean;
  onRemove: (index: number) => void;
}) {
  if (items.length === 0 && !reading) return null;
  return (
    <ul className="previews">
      {items.map((image, index) => {
        const url = thumbUrl(image);
        return (
          <li key={`${image.name}-${index}`} className="preview">
            {url ? <img src={url} alt={image.name} /> : null}
            <button type="button" className="preview-remove" onClick={() => onRemove(index)} aria-label={`Remove ${image.name}`}>
              <Close size={14} />
            </button>
          </li>
        );
      })}
      {reading ? <li className="preview preview-reading" aria-label="Reading photo" /> : null}
    </ul>
  );
}

/** Thumbnails inside a sent message. */
export function SentImages({ images }: { images: Attachment[] }) {
  if (images.length === 0) return null;
  return (
    <ul className="sent-images">
      {images.map((image, index) => {
        const url = thumbUrl(image);
        return (
          <li key={`${image.name}-${index}`}>
            {url ? <img src={url} alt={image.name} /> : <span className="sent-image-missing">Photo</span>}
          </li>
        );
      })}
    </ul>
  );
}
