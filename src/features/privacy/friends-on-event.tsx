import Link from "next/link";
import type { FriendActivity } from "./friend-activity";

/**
 * Friends attending or interested in one event (XRPL-085, XRPL-086).
 *
 * Only friends whose own settings permit it for this event appear, so an empty
 * panel means "nobody shared", never "nobody is going". The copy says so —
 * otherwise an absence reads as information it is not.
 */
export function FriendsOnEvent({
  activity,
  signedIn,
}: {
  activity: FriendActivity;
  signedIn: boolean;
}) {
  if (!signedIn) return null;

  const total = activity.attending.length + activity.interested.length;
  if (total === 0) return null;

  return (
    <section
      aria-labelledby="friends-heading"
      className="mt-8 rounded-card border border-border bg-surface-raised p-5"
    >
      <h2 id="friends-heading" className="text-lg font-semibold">
        People you know
      </h2>

      <div className="mt-4 flex flex-col gap-4">
        {activity.attending.length > 0 ? (
          <Group title="Went to this" friends={activity.attending} />
        ) : null}
        {activity.interested.length > 0 ? (
          <Group title="Interested" friends={activity.interested} />
        ) : null}
      </div>

      <p className="mt-4 border-t border-border pt-4 text-xs text-muted">
        Only friends who chose to share this appear here, so this is not a full list.{" "}
        <Link href="/privacy" className="font-medium text-accent underline">
          Choose what you share
        </Link>
      </p>
    </section>
  );
}

function Group({
  title,
  friends,
}: {
  title: string;
  friends: { userId: string; displayName: string }[];
}) {
  return (
    <div>
      <h3 className="text-sm font-medium text-muted">{title}</h3>
      <ul className="mt-2 flex flex-wrap gap-2">
        {friends.map((friend) => (
          <li key={friend.userId}>
            <Link
              href={`/customers/${friend.userId}`}
              className="inline-block rounded-full border border-border px-3 py-1 text-sm hover:bg-surface"
            >
              {friend.displayName}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
