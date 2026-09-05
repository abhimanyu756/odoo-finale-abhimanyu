-- CreateEnum
CREATE TYPE "LeaveApprovalMode" AS ENUM ('NONE', 'MANAGER', 'OFFICER');

-- CreateEnum
CREATE TYPE "WorkEntryType" AS ENUM ('PAID_LEAVE', 'UNPAID_LEAVE', 'SICK_LEAVE', 'COMPENSATORY_LEAVE');

-- AlterTable
ALTER TABLE "TimeOffType" ADD COLUMN     "approvalMode" "LeaveApprovalMode" NOT NULL DEFAULT 'MANAGER',
ADD COLUMN     "description" TEXT,
ADD COLUMN     "workEntry" "WorkEntryType" NOT NULL DEFAULT 'PAID_LEAVE';

