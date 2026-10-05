-- AlterTable
ALTER TABLE "SavingsGoal" ADD COLUMN     "description" TEXT,
ADD COLUMN     "reminderEnabled" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "GoalReminder" (
    "id" TEXT NOT NULL,
    "goalId" TEXT NOT NULL,
    "weekKey" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GoalReminder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GoalInsight" (
    "id" TEXT NOT NULL,
    "goalId" TEXT NOT NULL,
    "weekKey" TEXT NOT NULL,
    "feedback" TEXT NOT NULL,
    "estimatedMonthlySaveableCents" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GoalInsight_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GoalReminder_goalId_weekKey_key" ON "GoalReminder"("goalId", "weekKey");

-- CreateIndex
CREATE UNIQUE INDEX "GoalInsight_goalId_weekKey_key" ON "GoalInsight"("goalId", "weekKey");

-- AddForeignKey
ALTER TABLE "GoalReminder" ADD CONSTRAINT "GoalReminder_goalId_fkey" FOREIGN KEY ("goalId") REFERENCES "SavingsGoal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoalInsight" ADD CONSTRAINT "GoalInsight_goalId_fkey" FOREIGN KEY ("goalId") REFERENCES "SavingsGoal"("id") ON DELETE CASCADE ON UPDATE CASCADE;
