-- AlterTable
ALTER TABLE "Employee" ADD COLUMN     "hrResponsibleId" TEXT;

-- CreateIndex
CREATE INDEX "Employee_hrResponsibleId_idx" ON "Employee"("hrResponsibleId");

-- AddForeignKey
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_hrResponsibleId_fkey" FOREIGN KEY ("hrResponsibleId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;
