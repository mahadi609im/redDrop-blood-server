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

    app.get('/donationRequests/pending', async (req, res) => {
      try {
        const pendingRequests = await donationRequestsCollection
          .find({ status: 'pending' })
          .sort({ createdAt: -1 })
          .toArray();

        res.send(pendingRequests);
      } catch (err) {
        console.error(err);
        res.status(500).send({ message: 'Server Error' });
      }
    });

    // 1️⃣ My Donation Requests (Donor)
    app.get('/donationRequests/my', verifyFBToken, async (req, res) => {
      try {
        const email = req.decoded_email; // logged-in user's email
        const query = { requesterEmail: email };

        const cursor = donationRequestsCollection
          .find(query)
          .sort({ createdAt: -1 });
        const myRequests = await cursor.toArray();

        res.send(myRequests);
      } catch (err) {
        console.error(err);
        res.status(500).send({ message: 'Server Error' });
      }
    });

    // 2️⃣ All Donation Requests (Admin + Volunteer)
    app.get('/donationRequests', verifyFBToken, verifyAV, async (req, res) => {
      try {
        const cursor = donationRequestsCollection
          .find({})
          .sort({ createdAt: -1 });
        const allRequests = await cursor.toArray();

        res.send(allRequests);
      } catch (err) {
        console.error(err);
        res.status(500).send({ message: 'Server Error' });
      }
    });

    // 3️⃣ Get single donation request by id (any logged-in user)
    app.get('/donationRequests/:id', async (req, res) => {
      try {
        const id = req.params.id;

        if (!ObjectId.isValid(id)) {
          return res.status(400).send({ message: 'Invalid ID' });
        }

        const query = { _id: new ObjectId(id) };
        const request = await donationRequestsCollection.findOne(query);

        if (!request) return res.status(404).send({ message: 'Not Found' });

        if (request.requesterEmail !== req.decoded_email) {
          const user = await usersCollection.findOne({
            email: req.decoded_email,
          });

          if (user?.role === 'donor') {
            return res.status(403).send({ message: 'Forbidden' });
          }
        }

        res.send(request);
      } catch (err) {
        console.error(err);
        res.status(500).send({ message: 'Server Error' });
      }
    });

    // PATCH: Edit donation request (only allowed fields)
    app.patch('/donationRequests/:id', verifyFBToken, async (req, res) => {
      try {
        const id = req.params.id;
        const updates = req.body;

        if (!ObjectId.isValid(id)) {
          return res.status(400).send({ message: 'Invalid ID' });
        }

        const request = await donationRequestsCollection.findOne({
          _id: new ObjectId(id),
        });

        if (!request)
          return res.status(404).send({ message: 'Request not found' });

        // Check if logged-in user is the requester or admin/volunteer
        if (request.requesterEmail !== req.decoded_email) {
          const user = await usersCollection.findOne({
            email: req.decoded_email,
          });
          if (!user || (user.role !== 'admin' && user.role !== 'volunteer')) {
            return res.status(403).send({ message: 'Forbidden' });
          }
        }

        // Allowed fields to update
        const allowedFields = [
          'recipientName',
          'hospitalName',
          'district',
          'upazila',
          'fullAddress',
          'bloodGroup',
          'donationDate',
          'donationTime',
          'requestMessage',
        ];

        const filteredUpdates = {};
        allowedFields.forEach(field => {
          if (updates[field] !== undefined)
            filteredUpdates[field] = updates[field];
        });

        if (Object.keys(filteredUpdates).length === 0) {
          return res.status(400).send({ message: 'No valid fields to update' });
        }

        const result = await donationRequestsCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: filteredUpdates }
        );

        res.send(result);
      } catch (err) {
        console.error(err);
        res.status(500).send({ message: 'Server Error' });
      }
    });

    app.post('/donationRequests', async (req, res) => {
      const data = req.body;

      const donationRequest = {
        requesterName: data.requesterName,
        requesterEmail: data.requesterEmail,
        recipientName: data.recipientName,
        district: data.district,
        upazila: data.upazila,
        hospitalName: data.hospitalName,
        fullAddress: data.fullAddress,
        bloodGroup: data.bloodGroup,
        donationDate: data.donationDate,
        donationTime: data.donationTime,
        requestMessage: data.requestMessage,

        // server control fields
        status: 'pending', // default
        donorName: '',
        donorEmail: '',
        createdAt: new Date(),
      };

      const result = await donationRequestsCollection.insertOne(
        donationRequest
      );
      res.send(result);
    });

    app.delete('/donationRequests/:id', async (req, res) => {
      const id = req.params.id;

      const query = { _id: new ObjectId(id) };
      const result = await donationRequestsCollection.deleteOne(query);
      res.send(result);
    });

    app.patch('/donationRequests/:id/status', async (req, res) => {
      const id = req.params.id;
      const { status, donor } = req.body;

      const filter = { _id: new ObjectId(id) };

      const update = {
        $set: { status },
      };

      // যদি inprogress হলে donor info add করো
      if (status === 'inprogress' && donor) {
        update.$set.donor = {
          name: donor.name,
          email: donor.email,
        };
      }

      const result = await donationRequestsCollection.updateOne(filter, update);
      res.send(result);
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
