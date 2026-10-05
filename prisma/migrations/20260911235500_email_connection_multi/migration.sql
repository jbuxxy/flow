-- DropIndex
DROP INDEX "EmailConnection_userId_key";

-- CreateIndex
CREATE INDEX "EmailConnection_userId_idx" ON "EmailConnection"("userId");
