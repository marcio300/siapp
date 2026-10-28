import { DeviceFingerprint } from "@/components/device-fingerprint";

/** Member app shell: every member page records the device fingerprint. */
export default function MemberAppLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <DeviceFingerprint />
      {children}
    </>
  );
}
