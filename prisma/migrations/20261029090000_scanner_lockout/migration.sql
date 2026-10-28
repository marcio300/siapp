-- AlterTable
ALTER TABLE "Event" ADD COLUMN "scannerFailedLogins" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "scannerLockedUntil" TIMESTAMP(3);

-- AddForeignKey
ALTER TABLE "Scan" ADD CONSTRAINT "Scan_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
