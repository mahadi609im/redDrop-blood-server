const express = require('express');
const cors = require('cors');
const app = express();
const port = process.env.PORT || 3000;
require('dotenv').config();
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');

const admin = require('firebase-admin');

const serviceAccount = require('./reddrop-firebase-adminsdk.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// middleware
app.use(cors());
app.use(express.json());

const verifyFBToken = async (req, res, next) => {
  const token = req.headers.authorization;
  if (!token) {
    return res.status(401).send({ message: 'unauthorized access' });
  }

  try {
    const idToken = token.split(' ')[1];
    const decoded = await admin.auth().verifyIdToken(idToken);
    console.log('decoded in the token', decoded);
    req.decoded_email = decoded.email;
    next();
  } catch (err) {
    return res.status(401).send({ message: 'unauthorized access' });
  }
};

// redDrop
// KMgAnxqjIgaXYmVm

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.4k43auc.mongodb.net/?appName=Cluster0`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    await client.connect();
    const redDropDB = client.db('redDrop');
    const donationRequestsCollection = redDropDB.collection('donationRequests');
    const usersCollection = redDropDB.collection('users');

    const verifyAdmin = async (req, res, next) => {
      const email = req.decoded_email;
      const query = { email };
      const user = await usersCollection.findOne(query);

      if (!user || user.role !== 'admin') {
        return res.status(403).send({ message: 'forbidden access' });
      }

      next();
    };

    const verifyAV = async (req, res, next) => {
      const email = req.decoded_email;
      const query = { email };
      const user = await usersCollection.findOne(query);

      if (!user || user.role == 'donor') {
        return res.status(403).send({ message: 'forbidden access' });
      }

      next();
    };

    app.get('/donors', async (req, res) => {
      const { bloodGroup, district, upazila } = req.query;
      const query = { role: 'donor' };

      if (bloodGroup) query.bloodGroup = bloodGroup;
      if (district) query.district = district;
      if (upazila) query.upazila = upazila;

      const donors = await usersCollection.find(query).toArray();
      res.send(donors);
    });

    // Send a ping to confirm a successful connection
    await client.db('admin').command({ ping: 1 });
    console.log(
      'Pinged your deployment. You successfully connected to MongoDB!'
    );
  } finally {
    // Ensures that the client will close when you finish/error
    //  await client.close();
  }
}
run().catch(console.dir);

app.get('/', (req, res) => {
  res.send('bismillah');
});

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});
