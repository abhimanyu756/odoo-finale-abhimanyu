-- AlterTable
ALTER TABLE "Contract" ADD COLUMN     "reference" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "WorkingSchedule" ADD COLUMN     "companyId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Contract_reference_key" ON "Contract"("reference");

-- AddForeignKey
ALTER TABLE "WorkingSchedule" ADD CONSTRAINT "WorkingSchedule_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

