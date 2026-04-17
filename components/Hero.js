import Link from "next/link";
import config from "@/config";

const Hero = () => {
  return (
    <section className="relative overflow-hidden bg-base-100">
      {/* Dot grid + knowledge node circles */}
      <div
        className="absolute inset-0 opacity-[0.12]"
        style={{
          backgroundImage:
            "radial-gradient(circle, currentColor 1px, transparent 1px)",
          backgroundSize: "24px 24px",
        }}
      />
      <svg className="absolute inset-0 w-full h-full opacity-[0.12]" xmlns="http://www.w3.org/2000/svg">
        <circle cx="15%" cy="20%" r="60" stroke="currentColor" strokeWidth="1" fill="none" />
        <circle cx="75%" cy="15%" r="90" stroke="currentColor" strokeWidth="1" fill="none" />
        <circle cx="85%" cy="70%" r="50" stroke="currentColor" strokeWidth="1" fill="none" />
        <circle cx="10%" cy="75%" r="70" stroke="currentColor" strokeWidth="1" fill="none" />
        <circle cx="50%" cy="85%" r="40" stroke="currentColor" strokeWidth="1" fill="none" />
        <circle cx="35%" cy="30%" r="100" stroke="currentColor" strokeWidth="1" fill="none" />
        <circle cx="65%" cy="55%" r="75" stroke="currentColor" strokeWidth="1" fill="none" />
      </svg>

      <div className="relative max-w-3xl mx-auto px-8 py-24 lg:py-32 flex flex-col gap-10 items-center text-center">
        <h1 className="font-extrabold text-4xl lg:text-6xl tracking-tight">
          Turn podcast episodes into real learning
        </h1>
        <p className="text-base opacity-80 leading-relaxed max-w-2xl">
          Stay on top of your field, interests, and news. Every episode becomes a clear brief — key ideas explained, references unpacked, ready to save to your favorite notes app or act on right away.
        </p>
        <Link href={config.auth.loginUrl} className="btn btn-primary btn-wide">
          Try It Out
        </Link>
      </div>
    </section>
  );
};

export default Hero;
