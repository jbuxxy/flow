-- The month rollover now claims its report + budget-plan step separately
-- ("<YYYY-MM>:report", src/lib/scheduled-notifications.ts). Every month
-- already rolled over under the old single claim did both parts, so mark
-- them done too rather than re-running the report step once after deploy.
INSERT INTO "CycleAlert" ("id", "householdId", "periodKey", "sentAt")
SELECT gen_random_uuid()::text, "householdId", "periodKey" || ':report', "sentAt"
FROM "CycleAlert"
WHERE "periodKey" NOT LIKE '%:report'
ON CONFLICT ("householdId", "periodKey") DO NOTHING;
