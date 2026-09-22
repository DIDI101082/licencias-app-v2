export default function Mark({ className = "h-6 w-6" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M4 18L10 6H14L8 18H4Z" fill="#2F5CF0" />
      <path d="M9.5 18L15.5 6H19.5L13.5 18H9.5Z" fill="#7EA1F8" />
    </svg>
  );
}
