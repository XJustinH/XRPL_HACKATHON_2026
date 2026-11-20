/**
 * Validation message for a single form field.
 *
 * The `id` is referenced by the input's `aria-describedby`, so the message is
 * announced with the field rather than read as loose text.
 */
export function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} className="mt-1 text-sm text-critical">
      {message}
    </p>
  );
}
