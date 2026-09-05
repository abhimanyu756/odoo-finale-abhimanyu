import bcrypt from 'bcryptjs';
import { prisma } from '../src/lib/prisma.js';

const company = await prisma.company.upsert({
  where: { name: 'OxP Pvt Ltd' },
  update: {},
  create: { name: 'OxP Pvt Ltd', currency: 'INR' },
});

const user = await prisma.user.upsert({
  where: { email: 'admin@oxp.com' },
  update: {},
  create: {
    email: 'admin@oxp.com',
    passwordHash: await bcrypt.hash('Admin@123', 10),
    role: 'ADMIN',
  },
});

await prisma.employee.upsert({
  where: { workEmail: 'admin@oxp.com' },
  update: { userId: user.id },
  create: {
    firstName: 'System',
    lastName: 'Admin',
    workEmail: 'admin@oxp.com',
    companyId: company.id,
    userId: user.id,
  },
});

console.log('seeded admin@oxp.com / Admin@123');
await prisma.$disconnect();
