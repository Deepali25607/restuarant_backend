let ioRef = null

function attach(io) {
  ioRef = io
  io.on('connection', (socket) => {
    socket.on('join:order', (orderId) => {
      if (typeof orderId === 'string') socket.join(`order:${orderId}`)
    })
    socket.on('join:kitchen', () => socket.join('kitchen'))
    socket.on('join:admin', () => socket.join('admin'))
  })
}

function emit(event, payload) {
  if (!ioRef) return
  ioRef.emit(event, payload)
}

function emitOrderUpdate(order) {
  if (!ioRef) return
  ioRef.to(`order:${order.id}`).emit('order:updated', order)
  ioRef.to('kitchen').emit('order:updated', order)
  ioRef.to('admin').emit('order:updated', order)
}

function emitNewOrder(order) {
  if (!ioRef) return
  ioRef.to('kitchen').emit('order:new', order)
  ioRef.to('admin').emit('order:new', order)
}

function emitPaymentUpdate(order) {
  if (!ioRef) return
  ioRef.to(`order:${order.id}`).emit('order:paid', order)
  ioRef.to('admin').emit('order:paid', order)
}

function emitStockEvent(event, dish) {
  if (!ioRef) return
  ioRef.to('admin').emit(event, dish)
  ioRef.to('kitchen').emit(event, dish)
}

module.exports = {
  attach,
  emit,
  emitOrderUpdate,
  emitNewOrder,
  emitPaymentUpdate,
  emitStockEvent,
}
