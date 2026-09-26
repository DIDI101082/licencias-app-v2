export default function Mark({ className = "h-7" }: { className?: string }) {
  return (
    <img
      src="/accusys-logo.png"
      alt="Accusys Technology"
      className={`marca ${className} !w-auto object-contain`}
    />
  );
}
