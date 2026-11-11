// Minimal SMSC built on jsmpp, for the smpp-ts client interop suite.
//
//   java -cp jsmpp.jar:slf4j-api.jar test/interop/servers/JsmppSmsc.java <port>
//
// Accepts binds with system_id "smppts" / password "secret" (any bind type), answers submit_sm with a
// unique message id, and sends a delivery receipt (receipted id = submitted id) when one is requested.
import java.util.Date;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;

import org.jsmpp.PDUStringException;
import org.jsmpp.SMPPConstant;
import org.jsmpp.bean.*;
import org.jsmpp.extra.ProcessRequestException;
import org.jsmpp.session.*;
import org.jsmpp.util.DeliveryReceiptState;
import org.jsmpp.util.MessageId;

public class JsmppSmsc implements ServerMessageReceiverListener {
    private static final String SYSTEM_ID = "smppts";
    private static final String PASSWORD = "secret";
    private final AtomicLong ids = new AtomicLong(1000);
    private final ScheduledExecutorService receipts = Executors.newScheduledThreadPool(2);

    public static void main(String[] args) throws Exception {
        int port = Integer.parseInt(args.length > 0 ? args[0] : "2775");
        new JsmppSmsc().run(port);
    }

    void run(int port) throws Exception {
        ExecutorService binds = Executors.newCachedThreadPool();
        try (SMPPServerSessionListener listener = new SMPPServerSessionListener(port)) {
            System.out.println("jsmpp SMSC listening on " + port);
            while (true) {
                SMPPServerSession session = listener.accept();
                session.setMessageReceiverListener(this);
                binds.submit(() -> {
                    try {
                        BindRequest bind = session.waitForBind(10_000);
                        if (SYSTEM_ID.equals(bind.getSystemId()) && PASSWORD.equals(bind.getPassword())) {
                            bind.accept("jsmpp", InterfaceVersion.IF_34);
                        } else {
                            bind.reject(SMPPConstant.STAT_ESME_RBINDFAIL);
                        }
                    } catch (Exception e) {
                        System.err.println("bind failed: " + e);
                    }
                    return null;
                });
            }
        }
    }

    @Override
    public SubmitSmResult onAcceptSubmitSm(SubmitSm submitSm, SMPPServerSession source)
            throws ProcessRequestException {
        MessageId messageId;
        try {
            messageId = new MessageId(Long.toString(ids.incrementAndGet()));
        } catch (PDUStringException e) {
            throw new ProcessRequestException(e.getMessage(), SMPPConstant.STAT_ESME_RSYSERR);
        }
        if ((submitSm.getRegisteredDelivery() & 0x03) != 0) {
            receipts.schedule(() -> sendReceipt(source, submitSm, messageId), 200, TimeUnit.MILLISECONDS);
        }
        return new SubmitSmResult(messageId, new OptionalParameter[0]);
    }

    private void sendReceipt(SMPPServerSession session, SubmitSm submitSm, MessageId messageId) {
        if (!session.getSessionState().isReceivable()) return;
        try {
            DeliveryReceipt receipt = new DeliveryReceipt(messageId.getValue(), 1, 1, new Date(), new Date(),
                    DeliveryReceiptState.DELIVRD, "000", "");
            session.deliverShortMessage("",
                    TypeOfNumber.valueOf(submitSm.getDestAddrTon()), NumberingPlanIndicator.valueOf(submitSm.getDestAddrNpi()),
                    submitSm.getDestAddress(),
                    TypeOfNumber.valueOf(submitSm.getSourceAddrTon()), NumberingPlanIndicator.valueOf(submitSm.getSourceAddrNpi()),
                    submitSm.getSourceAddr(),
                    new ESMClass(MessageMode.DEFAULT, MessageType.SMSC_DEL_RECEIPT, GSMSpecificFeature.DEFAULT),
                    (byte) 0, (byte) 0, new RegisteredDelivery(0), DataCodings.ZERO,
                    receipt.toString().getBytes());
        } catch (Exception e) {
            System.err.println("receipt failed: " + e);
        }
    }

    @Override
    public SubmitMultiResult onAcceptSubmitMulti(SubmitMulti submitMulti, SMPPServerSession source)
            throws ProcessRequestException {
        throw new ProcessRequestException("not supported", SMPPConstant.STAT_ESME_RINVCMDID);
    }

    @Override
    public QuerySmResult onAcceptQuerySm(QuerySm querySm, SMPPServerSession source) throws ProcessRequestException {
        throw new ProcessRequestException("not supported", SMPPConstant.STAT_ESME_RINVCMDID);
    }

    @Override
    public void onAcceptReplaceSm(ReplaceSm replaceSm, SMPPServerSession source) throws ProcessRequestException {
        throw new ProcessRequestException("not supported", SMPPConstant.STAT_ESME_RINVCMDID);
    }

    @Override
    public void onAcceptCancelSm(CancelSm cancelSm, SMPPServerSession source) throws ProcessRequestException {
        throw new ProcessRequestException("not supported", SMPPConstant.STAT_ESME_RINVCMDID);
    }

    @Override
    public BroadcastSmResult onAcceptBroadcastSm(BroadcastSm broadcastSm, SMPPServerSession source)
            throws ProcessRequestException {
        throw new ProcessRequestException("not supported", SMPPConstant.STAT_ESME_RINVCMDID);
    }

    @Override
    public void onAcceptCancelBroadcastSm(CancelBroadcastSm cancelBroadcastSm, SMPPServerSession source)
            throws ProcessRequestException {
        throw new ProcessRequestException("not supported", SMPPConstant.STAT_ESME_RINVCMDID);
    }

    @Override
    public QueryBroadcastSmResult onAcceptQueryBroadcastSm(QueryBroadcastSm queryBroadcastSm, SMPPServerSession source)
            throws ProcessRequestException {
        throw new ProcessRequestException("not supported", SMPPConstant.STAT_ESME_RINVCMDID);
    }

    @Override
    public DataSmResult onAcceptDataSm(DataSm dataSm, Session source) throws ProcessRequestException {
        throw new ProcessRequestException("not supported", SMPPConstant.STAT_ESME_RINVCMDID);
    }
}
