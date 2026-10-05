-- CreateTable
CREATE TABLE "MerchantLogoDomain" (
    "merchant" TEXT NOT NULL,
    "domain" TEXT,
    "resolvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MerchantLogoDomain_pkey" PRIMARY KEY ("merchant")
);
