import { DeviceFingerprint } from "@/components/device-fingerprint";
import { PwaRegister } from "@/components/pwa-register";

/** Member app shell: every member page records the device fingerprint and registers the service worker. */
export default function MemberAppLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <DeviceFingerprint />
      <PwaRegister />
      {children}
    </>
  );
}
