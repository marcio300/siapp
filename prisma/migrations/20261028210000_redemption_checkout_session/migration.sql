-- AlterTable
ALTER TABLE "Redemption" ADD COLUMN "stripeCheckoutSessionId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Redemption_stripeCheckoutSessionId_key" ON "Redemption"("stripeCheckoutSessionId");
