import NextAuth from "next-auth";
import Nodemailer from "next-auth/providers/nodemailer";
import { PrismaAdapter } from "@auth/prisma-adapter";
import nodemailer from "nodemailer";

import { prisma } from "@/lib/db/prisma";

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: PrismaAdapter(prisma),
  session: { strategy: "database" },
  pages: {
    signIn: "/sign-in",
  },
  callbacks: {
    session({ session, user }) {
      session.user.id = user.id;
      return session;
    },
  },
  events: {
    // Every user gets a default AIConfiguration row (spec §32) so settings
    // pages never have to special-case "no config yet". The adapter always
    // sets `user.id` for this event; the guard is just for the type.
    async createUser({ user }) {
      if (!user.id) return;

      await prisma.aIConfiguration.upsert({
        where: { userId: user.id },
        update: {},
        create: { userId: user.id },
      });
    },
  },
  providers: [
    Nodemailer({
      // Required by the provider's own validation even though our
      // sendVerificationRequest below ignores it when EMAIL_SERVER is unset.
      server: process.env.EMAIL_SERVER || "smtp://localhost:1025",
      from: process.env.EMAIL_FROM,
      async sendVerificationRequest({ identifier, url }) {
        if (!process.env.EMAIL_SERVER) {
          console.log(`[auth] Dev mode — sign-in link for ${identifier}:\n${url}`);
          return;
        }

        const transport = nodemailer.createTransport(process.env.EMAIL_SERVER);
        await transport.sendMail({
          to: identifier,
          from: process.env.EMAIL_FROM,
          subject: "Sign in to InstaMate AI",
          text: `Sign in to InstaMate AI: ${url}`,
          html: `<p>Sign in to <strong>InstaMate AI</strong>:</p><p><a href="${url}">${url}</a></p>`,
        });
      },
    }),
  ],
});
