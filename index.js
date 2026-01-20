import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import cors from "cors";
import crypto from "crypto";
import admin from "firebase-admin";

dotenv.config();

/* ========================
   🔧 APP SETUP
======================== */
const app = express();

/* ========================
   🔥 FIREBASE INIT
======================== */
admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
  }),
});

const db = admin.firestore();

/* ========================
   🌐 MIDDLEWARES
======================== */
app.use(cors());
app.use(express.json());

/* ========================
   🔐 ENV
======================== */
const {
  NG_MODE,
  NG_GATEWAY_URL,
  NG_OUTLET,
  NG_KEY,
  NG_CURRENCY,
  PORT,
} = process.env;

if (!NG_GATEWAY_URL || !NG_OUTLET || !NG_KEY) {
  console.error("❌ Missing ENV");
  process.exit(1);
}

/* ========================
   🧪 HEALTH
======================== */
app.get("/", (_, res) => {
  res.send(`✅ NGenius backend OK (${NG_MODE})`);
});

/* ========================
   🔐 AUTH
======================== */
async function getAccessToken() {
  const res = await axios.post(
    `${NG_GATEWAY_URL}/identity/auth/access-token`,
    null,
    {
      headers: {
        Authorization: `Basic ${NG_KEY}`,
        "Content-Type": "application/vnd.ni-identity.v1+json",
        Accept: "application/vnd.ni-identity.v1+json",
      },
    }
  );
  return res.data.access_token;
}

/* ========================
   💳 CREATE PAYMENT (CORRIGÉ)
======================== */
app.post("/create-payment", async (req, res) => {
  try {
    const { 
      amount, 
      orderId, 
      userId,  // ← NOUVEAU: userId obligatoire
      items = [],   // ← NOUVEAU: items
      shippingCost = 0, // ← NOUVEAU: shippingCost
      shippingDetails = "", // ← NOUVEAU: shippingDetails
      promoCode = "", // ← NOUVEAU: promoCode
      paymentMethod = "card", // ← NOUVEAU: paymentMethod
      subtotal = 0 // ← NOUVEAU: subtotal
    } = req.body;
    
    if (!amount || !orderId || !userId) {
      console.error("❌ Missing required fields:", { amount, orderId, userId });
      return res.status(400).json({ 
        success: false, 
        message: "Missing required fields: amount, orderId, userId" 
      });
    }

    console.log("🛒 Création commande:", { 
      orderId, 
      userId, 
      amount, 
      itemsCount: items.length,
      shippingCost 
    });

    // 1️⃣ Créer order COMPLÈTE dans Firestore AVANT paiement
    const orderData = {
      // Identification
      id: orderId, // ← Champ id pour compatibilité
      orderId: orderId, // ← Copie pour référence
      userId: userId, // ← ESSENTIEL pour les requêtes
      
      // Articles
      items: items,
      itemsCount: items.length,
      
      // Prix
      total: amount,
      subtotal: subtotal || (amount - shippingCost),
      shippingCost: shippingCost,
      tax: 0, // ← Ajoutez si applicable
      discount: 0, // ← Ajoutez si applicable
      
      // Statut et paiement
      status: "pending",
      paymentMethod: paymentMethod,
      gateway: "ngenius",
      
      // Informations livraison
      shippingDetails: shippingDetails,
      promoCode: promoCode,
      
      // Métadonnées
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    await db.collection("orders").doc(orderId).set(orderData);
    console.log("✅ Commande créée dans Firestore:", orderId);

    // 2️⃣ Initialiser le paiement avec NGenius
    const token = await getAccessToken();

    const payload = {
      action: "SALE",
      amount: {
        currencyCode: NG_CURRENCY || "XOF",
        value: amount,
      },
      merchantAttributes: {
        redirectUrl: "https://a2-expres.com/payment/success.html",
        cancelUrl: "https://a2-expres.com/payment/cancel.html",
      },
      reference: orderId, // 🔑 Référence de la commande
    };

    const response = await axios.post(
      `${NG_GATEWAY_URL}/transactions/outlets/${NG_OUTLET}/orders`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/vnd.ni-payment.v2+json",
          Accept: "application/vnd.ni-payment.v2+json",
        },
      }
    );

    console.log("✅ Paiement initialisé avec NGenius:", response.data.reference);

    return res.json({
      success: true,
      paymentUrl: response.data._links.payment.href,
      reference: response.data.reference,
      orderId: orderId,
      raw: response.data, // ← Pour debug
    });
  } catch (err) {
    console.error("❌ Erreur create-payment:", err.response?.data || err.message);
    return res.status(500).json({ 
      success: false, 
      error: err.message,
      details: err.response?.data 
    });
  }
});

/* ========================
   🔔 NGenius WEBHOOK (CORRIGÉ)
======================== */
/* ========================
   🔔 NGenius WEBHOOK (CORRIGÉ)
======================== */
app.post(
  "/webhook/ngenius",
  express.raw({ type: "*/*" }),
  async (req, res) => {
    try {
      const rawBody = req.body.toString("utf8");
      const signature = req.headers["x-n-genius-signature"];

      console.log("📨 Webhook reçu - Signature:", signature ? "Présente" : "Absente");
      console.log("📨 Webhook raw body:", rawBody.substring(0, 500) + "...");

      if (!signature) {
        console.error("❌ Signature manquante");
        return res.status(401).send("Missing signature");
      }

      const expectedSignature = crypto
        .createHmac("sha256", process.env.NG_WEBHOOK_SECRET)
        .update(rawBody)
        .digest("hex");

      // 🔓 Désactivation temporaire de la vérification de signature (sandbox only)
      if (NG_MODE !== "sandbox") {
        if (signature !== expectedSignature) {
          console.error("❌ Signature invalide");
          console.log("Attendu:", expectedSignature);
          console.log("Reçu:", signature);
          return res.status(401).send("Invalid signature");
        }
      }

      const payload = JSON.parse(rawBody);
      console.log("📦 Payload webhook:", JSON.stringify(payload, null, 2));

      // Extraire les informations
      const orderId = payload?.order?.reference || 
                     payload?.orderReference || 
                     payload?.reference;
      
      const paymentState = payload?.payment?.state || 
                          payload?.state ||
                          payload?.order?.state;

      const gatewayReference = payload?.payment?.reference ||
                              payload?.reference ||
                              payload?.order?.reference;

      console.log("🔍 Informations extraites:", {
        orderId,
        paymentState,
        gatewayReference
      });

      if (!orderId || !paymentState) {
        console.error("❌ Payload invalide - manque orderId ou paymentState");
        return res.status(400).send("Invalid payload");
      }

      // Déterminer le statut de la commande
      let orderStatus = "pending";
      let paymentCaptured = false;
      
      if (paymentState === "CAPTURED" || paymentState === "PURCHASED") {
        orderStatus = "confirmed";
        paymentCaptured = true;
      } else if (paymentState === "FAILED" || paymentState === "DECLINED") {
        orderStatus = "cancelled";
      } else if (paymentState === "CANCELLED") {
        orderStatus = "cancelled";
      } else if (paymentState === "AUTHORIZED") {
        orderStatus = "pending";
      }

      console.log(`🔄 Mise à jour commande ${orderId}: ${paymentState} → ${orderStatus}`);

      // Mettre à jour la commande dans Firestore
      const updateData = {
        status: orderStatus,
        payment: {
          gateway: "ngenius",
          gatewayReference: gatewayReference,
          state: paymentState,
          captured: paymentCaptured,
          raw: payload,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };

      // Si le paiement est confirmé, ajouter la date de confirmation
      if (orderStatus === "confirmed") {
        updateData.confirmedAt = admin.firestore.FieldValue.serverTimestamp();
        updateData.payment.paidAt = admin.firestore.FieldValue.serverTimestamp();
      }

      await db.collection("orders").doc(orderId).update(updateData);
      
      console.log(`✅ Commande ${orderId} mise à jour avec statut: ${orderStatus}`);
      
      return res.status(200).send("OK");
    } catch (err) {
      console.error("❌ Erreur webhook:", err);
      return res.status(500).send("Server error");
    }
  }
);

/* ========================
   🔧 FIX MISSING ORDERS
======================== */
app.post("/fix-missing-order", async (req, res) => {
  try {
    const { 
      orderId, 
      userId, 
      items = [], 
      amount = 0, 
      shippingCost = 0,
      shippingDetails = "",
      status = "pending"
    } = req.body;
    
    if (!orderId || !userId) {
      return res.status(400).json({ 
        success: false, 
        message: "Missing orderId or userId" 
      });
    }

    console.log("🔧 Fix missing order:", { orderId, userId });

    // Vérifier si la commande existe déjà
    const orderDoc = await db.collection("orders").doc(orderId).get();
    
    if (orderDoc.exists) {
      // Mettre à jour si elle existe mais manque de données
      const existingData = orderDoc.data();
      const updateData = {
        userId: userId,
        items: items.length > 0 ? items : (existingData.items || []),
        shippingCost: shippingCost || existingData.shippingCost || 0,
        shippingDetails: shippingDetails || existingData.shippingDetails || "",
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };
      
      await db.collection("orders").doc(orderId).update(updateData);
      console.log(`✅ Commande existante mise à jour: ${orderId}`);
      
      return res.json({ 
        success: true, 
        message: "Order updated",
        action: "updated"
      });
    } else {
      // Créer la commande si elle n'existe pas
      const orderData = {
        id: orderId,
        orderId: orderId,
        userId: userId,
        items: items,
        itemsCount: items.length,
        status: status,
        total: amount,
        subtotal: amount - shippingCost,
        shippingCost: shippingCost,
        shippingDetails: shippingDetails,
        paymentMethod: "card",
        gateway: "ngenius",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };
      
      await db.collection("orders").doc(orderId).set(orderData);
      console.log(`✅ Commande créée rétroactivement: ${orderId}`);
      
      return res.json({ 
        success: true, 
        message: "Order created",
        action: "created"
      });
    }
  } catch (err) {
    console.error("❌ Erreur fix-missing-order:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

/* ========================
   📋 GET USER ORDERS (Pour debug)
======================== */
app.get("/user-orders/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    
    const snapshot = await db.collection("orders")
      .where("userId", "==", userId)
      .orderBy("createdAt", "desc")
      .get();
    
    const orders = [];
    snapshot.forEach(doc => {
      orders.push({
        id: doc.id,
        ...doc.data()
      });
    });
    
    console.log(`📋 Commandes trouvées pour ${userId}:`, orders.length);
    
    return res.json({
      success: true,
      count: orders.length,
      orders: orders
    });
  } catch (err) {
    console.error("❌ Erreur get user orders:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

/* ========================
   🚀 START SERVER
======================== */
const port = PORT || 3000;
app.listen(port, () => {
  console.log(`🚀 Server running on port ${port} (${NG_MODE})`);
  console.log(`📝 Endpoints disponibles:`);
  console.log(`   POST /create-payment`);
  console.log(`   POST /webhook/ngenius`);
  console.log(`   POST /fix-missing-order`);
  console.log(`   GET  /user-orders/:userId`);
});