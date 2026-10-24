CREATE TABLE "EmailSenderStat" (
    "id" TEXT NOT NULL,
    "householdId" TEXT NOT NULL,
    "sender" TEXT NOT NULL,
    "subjectKey" TEXT NOT NULL,
    "usefulCount" INTEGER NOT NULL DEFAULT 0,
    "uselessCount" INTEGER NOT NULL DEFAULT 0,
    "uselessStreak" INTEGER NOT NULL DEFAULT 0,
    "lastAiCheckAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailSenderStat_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EmailSenderStat_householdId_sender_subjectKey_key" ON "EmailSenderStat"("householdId", "sender", "subjectKey");

ALTER TABLE "EmailSenderStat" ADD CONSTRAINT "EmailSenderStat_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;
