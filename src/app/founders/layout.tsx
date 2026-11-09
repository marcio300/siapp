import { ConsentBanner } from "@/components/consent-banner";

/** The founders pages carry the one optional tracker (Meta pixel) behind a consent banner. */
export default function FoundersLayout({ children }: { children: React.ReactNode }) {
  const pixelEnabled = Boolean(process.env.NEXT_PUBLIC_META_PIXEL_ID);
  return (
    <>
      {children}
      <ConsentBanner enabled={pixelEnabled} />
    </>
  );
}
