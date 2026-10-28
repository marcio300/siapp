-- AlterTable
ALTER TABLE "KeyTransaction" ADD COLUMN "reference" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "KeyTransaction_type_reference_key" ON "KeyTransaction"("type", "reference");

-- CreateIndex
CREATE INDEX "KeyTransaction_memberId_createdAt_idx" ON "KeyTransaction"("memberId", "createdAt");
