export default function CreditBalance({ credits }) {
  return (
    <p className="text-sm text-base-content/60">
      {credits} credit{credits === 1 ? "" : "s"} remaining
    </p>
  );
}
